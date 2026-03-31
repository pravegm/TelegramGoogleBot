Set objShell = CreateObject("Wscript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
objShell.Run "cmd /c cd /d """ & strPath & """ && node bot.js >> bot.log 2>&1", 0, False
