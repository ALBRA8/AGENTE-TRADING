' ================================================================
' arranque_silencioso.vbs — lanza 1-INICIAR-AGENTE.bat sin que
' se vea ninguna ventana de configuracion (usado por la tarea de
' Windows que crea 4-CONFIGURAR-INICIO-AUTOMATICO.bat).
'
' Las consolas del Bridge y del Bot siguen apareciendo minimizadas
' en la barra de tareas (AGT-Bridge / AGT-Bot): asi siempre puedes
' ver que esta vivo sin abrir nada.
' ================================================================
Option Explicit

Dim sh, fso, carpeta
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta

' Modo silencioso: sin panel final, sin pausas, sin navegador
sh.Environment("PROCESS").Item("SILENCIOSO") = "1"
sh.Environment("PROCESS").Item("ABRIR_DASH") = "0"

sh.Run "cmd /c """ & carpeta & "\1-INICIAR-AGENTE.bat""", 0, False
