Output assets/demo-light.gif
Set Shell zsh
Set FontSize 13
Set FontFamily "JetBrains Mono"
Set Width 900
Set Height 700
Set Padding 20
Set WindowBar Colorful
Set BorderRadius 10
Set Margin 20
Set MarginFill "#eff1f5"
Set Theme "Catppuccin Latte"
Env CLAUDECODE ""

# Doctor diagnostics
Type "npx imessage-mcp doctor"
Sleep 300ms
Enter
Sleep 7s
Sleep 1s

# Launch Claude interactive mode
Type "claude --dangerously-skip-permissions"
Sleep 300ms
Enter
Sleep 5s

# Ask a fun question inside Claude's UI
Type "am i a night owl or early bird texter? just 2-3 sentences"
Sleep 300ms
Enter
Sleep 35s
Sleep 3s
