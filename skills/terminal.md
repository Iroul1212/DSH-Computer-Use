---
app: Windows Terminal
match: WindowsTerminal.exe, powershell.exe, pwsh.exe, cmd.exe, 终端, 命令提示符
summary: 复制粘贴、历史、清屏、多标签
---
- 复制选中文本 ctrl+c（有选中时）或 ctrl+shift+c；粘贴 ctrl+v 或 ctrl+shift+v。
- 新建标签 ctrl+shift+t，关闭 ctrl+shift+w，切换 ctrl+Tab。
- 清屏 cls（cmd）/ clear（powershell）。
- 历史命令 上/下方向键；ctrl+r 反向搜索（PowerShell 与 PSReadLine 支持）。
- 补全 Tab；PowerShell 里 ctrl+space 触发菜单补全。
- 中断当前命令 ctrl+c；结束当前行 ctrl+Home 行首、ctrl+End 行尾。
- 命令跑很久时不要盲等：先看提示符是否回来，或用 ctrl+c 中断再检查。
- 需要长输出时把结果重定向到文件（> out.txt）再读文件，比在终端里翻屏稳。