#requires -Version 5.1
<#
  overlay.ps1 - DeepSeek Harness "AI is controlling this computer" visible indicator.

  Standalone GUI process (WinForms). Draws a click-through, never-focusing overlay:
    * a soft orange glow around all four screen edges (slow breathing animation), and
    * a small rounded status pill: "DeepSeek Harness 正在操控你的电脑 · 按 Esc 停止"

  Global Esc is polled with GetAsyncKeyState(0x1B) (NOT RegisterHotKey, so we never
  steal a hotkey from another program). On Esc -> emit abort on stdout, then exit 0.

  stdout carries NDJSON only. Everything else goes to stderr.
  Contract (see notes/win-host-protocol.md):
    {"event":"ready","result":{"hwnd":int,"bounds":{x,y,width,height},"pid":int}}
    {"event":"abort","result":{"reason":"escape","at":"<ISO8601>"}}
    {"event":"selftest","result":{"ok":true}}

  Usage:
    pwsh -NoProfile -File overlay.ps1 [-Message <text>] [-Opacity 0..1]
         [-Mode border|pill|both] [-DisableHotkey] [-AutoCloseSeconds <n>] [-SelfTest]
#>
[CmdletBinding()]
param(
    [string]$Message = 'DeepSeek Harness 正在操控你的电脑 · 按 Esc 停止',
    [double]$Opacity = 1.0,
    [ValidateSet('border', 'pill', 'both')][string]$Mode = 'both',
    [switch]$DisableHotkey,
    [int]$AutoCloseSeconds = 0,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# stdout must stay pure NDJSON; force UTF-8 (no BOM) so the parent reads UTF-8.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Write-OverlayErr([string]$m) {
    try { [Console]::Error.WriteLine('overlay: ' + $m) } catch { }
}

if ([double]::IsNaN($Opacity)) { $Opacity = 1.0 }
if ($Opacity -lt 0) { $Opacity = 0 }
if ($Opacity -gt 1) { $Opacity = 1 }
if ($AutoCloseSeconds -lt 0) { $AutoCloseSeconds = 0 }

$overlaySource = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshOverlay
{
    /// <summary>
    /// Borderless, topmost, click-through, never-activating indicator window.
    /// Painted via UpdateLayeredWindow (per-pixel alpha) so the glow fades smoothly
    /// instead of being a hard-edged coloured rectangle.
    /// </summary>
    public class GuardForm : Form
    {
        const int WS_EX_LAYERED     = 0x00080000;
        const int WS_EX_TRANSPARENT = 0x00000020;
        const int WS_EX_NOACTIVATE  = 0x08000000;
        const int WS_EX_TOOLWINDOW  = 0x00000080;
        const int ULW_ALPHA         = 0x00000002;
        const byte AC_SRC_OVER      = 0x00;
        const byte AC_SRC_ALPHA     = 0x01;
        const int WM_MOUSEACTIVATE  = 0x0021;
        const int MA_NOACTIVATE     = 3;
        const int WM_NCHITTEST      = 0x0084;
        const int HTTRANSPARENT     = -1;
        const int VK_ESCAPE         = 0x1B;

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        struct SIZE { public int cx; public int cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst,
            ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey,
            ref BLENDFUNCTION pblend, int dwFlags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);

        /// <summary>Per-monitor-v2 DPI awareness. Must run before the first window exists.</summary>
        public static bool EnableDpiAwareness()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
            try { return SetProcessDPIAware(); } catch { return false; }
        }

        public string Message = "DeepSeek Harness";
        public double GlowOpacity = 1.0;
        public string Mode = "both";
        public bool HotkeyEnabled = true;
        public int AutoCloseSeconds = 0;
        public int SelfTestSeconds = 0;

        Bitmap _glowLayer;
        Bitmap _pillLayer;
        Bitmap _frame;
        PointerForm _pointer;
        int _pillX, _pillY;
        float _s = 1f;
        Timer _escTimer, _animTimer, _auxTimer;
        double _phase;
        bool _prevDown;
        bool _tripped;
        bool _shown;

        public GuardForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            Bounds = SystemInformation.VirtualScreen;
            BackColor = Color.Black;
            Text = "DeepSeek Harness overlay";
        }

        // Never steal activation, even if Windows decides to try.
        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        // The window is painted exclusively via UpdateLayeredWindow.
        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_MOUSEACTIVATE) { m.Result = (IntPtr)MA_NOACTIVATE; return; }
            if (m.Msg == WM_NCHITTEST) { m.Result = (IntPtr)HTTRANSPARENT; return; }
            base.WndProc(ref m);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (_shown) return;
            _shown = true;

            try
            {
                uint dpi = GetDpiForWindow(Handle);
                if (dpi >= 48 && dpi <= 1000) _s = dpi / 96f;
            }
            catch { }
            if (_s <= 0.1f || _s > 8f) _s = 1f;

            BuildLayers();
            Compose(1.0);

            // A second, tiny window follows the pointer: the human needs to see
            // which cursor belongs to the agent without the system cursor changing.
            if (Mode != "none") {
                _pointer = new PointerForm((int)Math.Round(96 * _s));
                _pointer.Show();
                _pointer.StartFollowing();
            }

            _prevDown = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;

            if (HotkeyEnabled && SelfTestSeconds <= 0)
            {
                _escTimer = new Timer();
                _escTimer.Interval = 40;
                _escTimer.Tick += EscTick;
                _escTimer.Start();
            }

            if (Mode != "pill")
            {
                _animTimer = new Timer();
                _animTimer.Interval = 160;
                _animTimer.Tick += delegate
                {
                    _phase += 0.13;
                    if (_phase > Math.PI * 2.0) _phase -= Math.PI * 2.0;
                    double mul = 0.70 + 0.30 * (0.5 + 0.5 * Math.Sin(_phase));
                    Compose(mul);
                };
                _animTimer.Start();
            }

            if (SelfTestSeconds > 0)
            {
                _auxTimer = new Timer();
                _auxTimer.Interval = SelfTestSeconds * 1000;
                _auxTimer.Tick += delegate
                {
                    _auxTimer.Stop();
                    Emit("selftest", "{\"ok\":true}");
                    Quit();
                };
                _auxTimer.Start();
            }
            else if (AutoCloseSeconds > 0)
            {
                _auxTimer = new Timer();
                _auxTimer.Interval = AutoCloseSeconds * 1000;
                _auxTimer.Tick += delegate { _auxTimer.Stop(); Quit(); };
                _auxTimer.Start();
            }

            Emit("ready",
                "{\"hwnd\":" + Handle.ToInt64().ToString(CultureInfo.InvariantCulture) +
                ",\"bounds\":{\"x\":" + Bounds.X.ToString(CultureInfo.InvariantCulture) +
                ",\"y\":" + Bounds.Y.ToString(CultureInfo.InvariantCulture) +
                ",\"width\":" + Width.ToString(CultureInfo.InvariantCulture) +
                ",\"height\":" + Height.ToString(CultureInfo.InvariantCulture) + "}" +
                ",\"pid\":" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + "}");
        }

        // ---------------------------------------------------------------- Esc

        void EscTick(object sender, EventArgs e)
        {
            bool down = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
            if (down && !_prevDown)
            {
                _prevDown = down;
                Trip("escape");
                return;
            }
            _prevDown = down;
        }

        void Trip(string reason)
        {
            if (_tripped) return;
            _tripped = true;
            try { if (_escTimer != null) _escTimer.Stop(); } catch { }
            try { if (_animTimer != null) _animTimer.Stop(); } catch { }
            try { if (_auxTimer != null) _auxTimer.Stop(); } catch { }
            Emit("abort",
                "{\"reason\":\"" + reason + "\",\"at\":\"" +
                DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\"}");
            Quit();
        }

        void Quit()
        {
            try { Close(); } catch { }
            try { Application.Exit(); } catch { }
        }

        // ------------------------------------------------------------- stdout

        static void Emit(string evt, string resultJson)
        {
            try
            {
                Console.Out.WriteLine("{\"event\":\"" + evt + "\",\"result\":" + resultJson + "}");
                Console.Out.Flush();
            }
            catch { }
        }

        // ------------------------------------------------------------- layers

        void BuildLayers()
        {
            int w = Width, h = Height;

            _glowLayer = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(_glowLayer))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                if (Mode != "pill") PaintGlow(g, w, h);
            }

            if (Mode != "border") BuildPill();
        }

        void PaintGlow(Graphics g, int w, int h)
        {
            // Codex-style blue vignette: a soft gradient that fades from the screen
            // edge inwards, brightened in the corners, topped with one crisp hairline
            // so the boundary reads as deliberate rather than as a smudge.
            int band = (int)Math.Round(Math.Min(w, h) * 0.12);
            int minBand = (int)(48 * _s);
            if (band < minBand) band = minBand;
            int maxBand = (int)Math.Round(Math.Min(w, h) * 0.28);
            if (band > maxBand) band = maxBand;
            if (band < 10) band = 10;

            int a = (int)Math.Round(150 * GlowOpacity);
            if (a <= 0) return;
            Color edge = Color.FromArgb(a, 56, 132, 255);
            Color clear = Color.FromArgb(0, 20, 60, 160);

            using (LinearGradientBrush br = new LinearGradientBrush(new Rectangle(0, 0, w, band), edge, clear, LinearGradientMode.Vertical))
            { g.FillRectangle(br, 0, 0, w, band); }
            using (LinearGradientBrush br = new LinearGradientBrush(new Rectangle(0, h - band, w, band), clear, edge, LinearGradientMode.Vertical))
            { g.FillRectangle(br, 0, h - band, w, band); }
            using (LinearGradientBrush br = new LinearGradientBrush(new Rectangle(0, 0, band, h), edge, clear, LinearGradientMode.Horizontal))
            { g.FillRectangle(br, 0, 0, band, h); }
            using (LinearGradientBrush br = new LinearGradientBrush(new Rectangle(w - band, 0, band, h), clear, edge, LinearGradientMode.Horizontal))
            { g.FillRectangle(br, w - band, 0, band, h); }

            int cr = (int)(band * 1.5);
            Point[] corners = new Point[] { new Point(0, 0), new Point(w, 0), new Point(0, h), new Point(w, h) };
            foreach (Point corner in corners)
            {
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddEllipse(corner.X - cr, corner.Y - cr, cr * 2, cr * 2);
                    using (PathGradientBrush pg = new PathGradientBrush(path))
                    {
                        pg.CenterColor = Color.FromArgb((int)(a * 0.5), 40, 120, 255);
                        pg.SurroundColors = new Color[] { clear };
                        g.FillPath(pg, path);
                    }
                }
            }

            float lw = Math.Max(1.5f, 1.8f * _s);
            using (Pen pen = new Pen(Color.FromArgb(Math.Min(255, (int)(a * 0.85)), 96, 172, 255), lw))
            { g.DrawRectangle(pen, lw / 2f, lw / 2f, w - lw, h - lw); }
        }

        void BuildPill()
        {
            // "COMPUTER USE" chip plus the deployment's own message, so the label is
            // always the same word a user can search for, whatever the message says.
            string message = Message;
            if (string.IsNullOrEmpty(message)) message = "正在操控你的电脑 · 按 Esc 停止";
            string label = "COMPUTER USE";

            float labelSize = 9.5f * _s;
            float msgSize = 10.5f * _s;
            using (Font labelFont = new Font("Segoe UI", labelSize, FontStyle.Bold, GraphicsUnit.Point))
            using (Font msgFont = new Font("Microsoft YaHei UI", msgSize, FontStyle.Regular, GraphicsUnit.Point))
            {
                SizeF ls, ms;
                using (Bitmap probe = new Bitmap(1, 1))
                using (Graphics pg = Graphics.FromImage(probe))
                {
                    pg.TextRenderingHint = TextRenderingHint.AntiAlias;
                    ls = pg.MeasureString(label, labelFont, new PointF(0, 0), StringFormat.GenericTypographic);
                    ms = pg.MeasureString(message, msgFont, new PointF(0, 0), StringFormat.GenericTypographic);
                }

                int padX = (int)Math.Round(14 * _s);
                int padY = (int)Math.Round(7 * _s);
                int dot = (int)Math.Round(8 * _s);
                int gap = (int)Math.Round(9 * _s);
                int sep = (int)Math.Round(12 * _s);
                int textH = (int)Math.Ceiling(Math.Max(ls.Height, ms.Height)) + 1;
                int ph = textH + padY * 2;
                int pw = padX * 2 + dot + gap + (int)Math.Ceiling(ls.Width) + sep + (int)Math.Ceiling(ms.Width);
                if (pw < 60) pw = 60;
                if (ph < 22) ph = 22;

                _pillLayer = new Bitmap(pw, ph, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(_pillLayer))
                {
                    g.Clear(Color.Transparent);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAlias;

                    int bgA = (int)Math.Round(226 * GlowOpacity);
                    int fgA = (int)Math.Round(246 * GlowOpacity);
                    int bdA = (int)Math.Round(235 * GlowOpacity);

                    using (GraphicsPath path = RoundRect(new RectangleF(0.5f, 0.5f, pw - 1f, ph - 1f), ph / 2f))
                    {
                        using (SolidBrush b = new SolidBrush(Color.FromArgb(bgA, 12, 14, 22))) g.FillPath(b, path);
                        using (Pen pen = new Pen(Color.FromArgb(bdA, 56, 138, 255), Math.Max(1.2f, 1.6f * _s))) g.DrawPath(pen, path);
                    }

                    float cy = ph / 2f;
                    float cx = padX + dot / 2f;
                    using (SolidBrush halo = new SolidBrush(Color.FromArgb((int)Math.Round(70 * GlowOpacity), 60, 150, 255)))
                    { g.FillEllipse(halo, cx - dot, cy - dot, dot * 2f, dot * 2f); }
                    using (SolidBrush db = new SolidBrush(Color.FromArgb((int)Math.Round(255 * GlowOpacity), 70, 160, 255)))
                    { g.FillEllipse(db, cx - dot / 2f, cy - dot / 2f, dot, dot); }

                    StringFormat sf = new StringFormat(StringFormat.GenericTypographic);
                    sf.LineAlignment = StringAlignment.Center;
                    sf.Alignment = StringAlignment.Near;
                    sf.FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.NoClip;

                    float tx = padX + dot + gap;
                    using (SolidBrush lb = new SolidBrush(Color.FromArgb(fgA, 118, 190, 255)))
                    { g.DrawString(label, labelFont, lb, new RectangleF(tx, 0f, ls.Width + 2, ph), sf); }
                    tx += (float)Math.Ceiling(ls.Width) + sep;
                    using (SolidBrush tb = new SolidBrush(Color.FromArgb(fgA, 235, 239, 247)))
                    { g.DrawString(message, msgFont, tb, new RectangleF(tx, 0f, pw - tx - padX + 4, ph), sf); }
                }

                _pillX = (Width - pw) / 2;
                _pillY = (int)Math.Round(30 * _s);
            }
        }

        static GraphicsPath RoundRect(RectangleF r, float radius)
        {
            GraphicsPath p = new GraphicsPath();
            if (radius * 2f > r.Width) radius = r.Width / 2f;
            if (radius * 2f > r.Height) radius = r.Height / 2f;
            float d = radius * 2f;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        void Compose(double alphaMul)
        {
            if (_frame == null) _frame = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(_frame))
            {
                g.Clear(Color.Transparent);
                g.CompositingMode = CompositingMode.SourceOver;
                g.InterpolationMode = InterpolationMode.NearestNeighbor;

                if (_glowLayer != null)
                {
                    using (ImageAttributes ia = new ImageAttributes())
                    {
                        ColorMatrix cm = new ColorMatrix();
                        cm.Matrix33 = (float)alphaMul;
                        ia.SetColorMatrix(cm, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                        g.DrawImage(_glowLayer, new Rectangle(0, 0, Width, Height),
                            0, 0, Width, Height, GraphicsUnit.Pixel, ia);
                    }
                }
                if (_pillLayer != null) g.DrawImageUnscaled(_pillLayer, _pillX, _pillY);
            }
            Push();
        }

        void Push()
        {
            if (!IsHandleCreated) return;
            IntPtr screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero) return;
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr hBmp = IntPtr.Zero;
            IntPtr old = IntPtr.Zero;
            try
            {
                hBmp = _frame.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(memDc, hBmp);
                SIZE size; size.cx = _frame.Width; size.cy = _frame.Height;
                POINT src; src.X = 0; src.Y = 0;
                POINT dst; dst.X = Left; dst.Y = Top;
                BLENDFUNCTION bf;
                bf.BlendOp = AC_SRC_OVER;
                bf.BlendFlags = 0;
                bf.SourceConstantAlpha = 255;
                bf.AlphaFormat = AC_SRC_ALPHA;
                UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref bf, ULW_ALPHA);
            }
            finally
            {
                if (hBmp != IntPtr.Zero) { SelectObject(memDc, old); DeleteObject(hBmp); }
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { if (_escTimer != null) _escTimer.Dispose(); } catch { }
                try { if (_animTimer != null) _animTimer.Dispose(); } catch { }
                try { if (_auxTimer != null) _auxTimer.Dispose(); } catch { }
                try { if (_glowLayer != null) _glowLayer.Dispose(); } catch { }
                try { if (_pillLayer != null) _pillLayer.Dispose(); } catch { }
                try { if (_frame != null) _frame.Dispose(); } catch { }
                try { if (_pointer != null) { _pointer.StopFollowing(); _pointer.Dispose(); } } catch { }
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>
    /// Small always-on-top ring that follows the pointer while computer use is
    /// active, so a human can tell the agent's target from their own cursor.
    /// It is its own tiny layered window: recomposing 96x96 costs nothing, while
    /// repainting the full-screen guard at 30 Hz would not.
    /// </summary>
    public class PointerForm : Form
    {
        const int WS_EX_LAYERED     = 0x00080000;
        const int WS_EX_TRANSPARENT = 0x00000020;
        const int WS_EX_NOACTIVATE  = 0x08000000;
        const int WS_EX_TOOLWINDOW  = 0x00000080;
        const int ULW_ALPHA         = 0x00000002;
        const int WM_MOUSEACTIVATE  = 0x0021;
        const int MA_NOACTIVATE     = 3;
        const int WM_NCHITTEST      = 0x0084;
        const int HTTRANSPARENT     = -1;
        const byte AC_SRC_OVER      = 0x00;
        const byte AC_SRC_ALPHA     = 0x01;

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        struct SIZE { public int cx; public int cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst,
            ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

        readonly int _size;
        Bitmap _bmp;
        Timer _timer;
        double _phase;
        bool _visible;

        public PointerForm(int size)
        {
            _size = size;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            Bounds = new Rectangle(-size * 2, -size * 2, size, size);
            BackColor = Color.Black;
            Text = "DeepSeek Harness pointer";
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_MOUSEACTIVATE) { m.Result = (IntPtr)MA_NOACTIVATE; return; }
            if (m.Msg == WM_NCHITTEST) { m.Result = (IntPtr)HTTRANSPARENT; return; }
            base.WndProc(ref m);
        }

        /// <summary>Start following the pointer. Idempotent.</summary>
        public void StartFollowing()
        {
            if (_timer != null) return;
            _visible = true;
            _timer = new Timer();
            _timer.Interval = 33;
            _timer.Tick += delegate { Tick(); };
            _timer.Start();
            Tick();
        }

        public void StopFollowing()
        {
            _visible = false;
            try { if (_timer != null) { _timer.Stop(); _timer.Dispose(); } } catch { }
            _timer = null;
            try { if (Visible) Hide(); } catch { }
        }

        void Tick()
        {
            if (!_visible) return;
            POINT p;
            if (!GetCursorPos(out p)) return;
            _phase += 0.17;
            if (_phase > Math.PI * 2.0) _phase -= Math.PI * 2.0;
            Draw();
            int x = p.X - _size / 2;
            int y = p.Y - _size / 2;
            if (x != Left || y != Top) { Left = x; Top = y; }
            Push();
        }

        void Draw()
        {
            if (_bmp == null) _bmp = new Bitmap(_size, _size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(_bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                float c = _size / 2f;
                double pulse = 0.72 + 0.28 * (0.5 + 0.5 * Math.Sin(_phase));

                // Soft blue halo, painted outside-in so the ring stays crisp.
                for (int i = 4; i >= 1; i--)
                {
                    float r = 9f + i * 5.5f;
                    int a = (int)Math.Round(24 * pulse);
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(a, 40, 140, 255)))
                    { g.FillEllipse(b, c - r, c - r, r * 2f, r * 2f); }
                }
                using (Pen ring = new Pen(Color.FromArgb((int)Math.Round(240 * pulse), 60, 165, 255), 2.6f))
                { g.DrawEllipse(ring, c - 11.5f, c - 11.5f, 23f, 23f); }
                using (Pen inner = new Pen(Color.FromArgb(200, 255, 255, 255), 1.1f))
                { g.DrawEllipse(inner, c - 5.5f, c - 5.5f, 11f, 11f); }
                using (Pen tick = new Pen(Color.FromArgb((int)Math.Round(225 * pulse), 95, 185, 255), 2f))
                {
                    g.DrawLine(tick, c - 18f, c, c - 13.5f, c);
                    g.DrawLine(tick, c + 13.5f, c, c + 18f, c);
                    g.DrawLine(tick, c, c - 18f, c, c - 13.5f);
                    g.DrawLine(tick, c, c + 13.5f, c, c + 18f);
                }
            }
        }

        void Push()
        {
            if (!IsHandleCreated || _bmp == null) return;
            IntPtr screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero) return;
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr hBmp = IntPtr.Zero;
            IntPtr old = IntPtr.Zero;
            try
            {
                hBmp = _bmp.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(memDc, hBmp);
                SIZE size; size.cx = _bmp.Width; size.cy = _bmp.Height;
                POINT src; src.X = 0; src.Y = 0;
                POINT dst; dst.X = Left; dst.Y = Top;
                BLENDFUNCTION bf;
                bf.BlendOp = AC_SRC_OVER;
                bf.BlendFlags = 0;
                bf.SourceConstantAlpha = 255;
                bf.AlphaFormat = AC_SRC_ALPHA;
                UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref bf, ULW_ALPHA);
            }
            finally
            {
                if (hBmp != IntPtr.Zero) { SelectObject(memDc, old); DeleteObject(hBmp); }
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { if (_timer != null) { _timer.Stop(); _timer.Dispose(); } } catch { }
                try { if (_bmp != null) _bmp.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
    }
}
'@

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $refs = [System.AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { -not $_.IsDynamic -and $_.Location } |
        Select-Object -ExpandProperty Location -Unique
    Add-Type -TypeDefinition $overlaySource -ReferencedAssemblies $refs -ErrorAction Stop
} catch {
    Write-OverlayErr ('failed to compile overlay UI: ' + $_.Exception.Message)
    exit 1
}

try {
    [DshOverlay.GuardForm]::EnableDpiAwareness() | Out-Null
    $form = New-Object DshOverlay.GuardForm
    $form.Message = $Message
    $form.GlowOpacity = $Opacity
    $form.Mode = $Mode
    $form.HotkeyEnabled = (-not $DisableHotkey)
    $form.AutoCloseSeconds = $AutoCloseSeconds
    if ($SelfTest) { $form.SelfTestSeconds = 2 } else { $form.SelfTestSeconds = 0 }
    try {
        [System.Windows.Forms.Application]::Run($form)
    } finally {
        # Safety net: if this process is going away, hand the user their own cursor
        # scheme back even when the runtime that armed us is already gone.
        try {
            Add-Type -Namespace DshOverlayCursor -Name Api -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfoW(uint a, uint b, IntPtr c, uint d);' -ErrorAction SilentlyContinue | Out-Null
            [void][DshOverlayCursor.Api]::SystemParametersInfoW(0x0057, 0, [IntPtr]::Zero, 0)
        } catch { }
    }
} catch {
    Write-OverlayErr ('overlay crashed: ' + $_.Exception.ToString())
    exit 1
}

exit 0

