' ============================================================
'  AGENTE-TRADING - DESPLIEGUE RAPIDO (UN doble clic para todo)
'
'  - Si ya esta instalado (.env + node_modules): lanza TODO
'    oculto (cero ventanas de configuracion) y el propio
'    arrancador abre el navegador en el dashboard
'    http://127.0.0.1:6879 cuando responde. Las consolas
'    AGT-Bridge / AGT-Bot quedan minimizadas en la barra de
'    tareas para que siempre puedas ver que esta vivo.
'  - Si es la primera vez: abre el asistente visible
'    INSTALAR-AGENTE.bat (crea .env, instala dependencias y
'    arranca). Solo aparece esa unica vez.
'
'  El auto-arranque con Windows sigue usando arranque_silencioso.vbs
'  (tarea de 4-CONFIGURAR-INICIO-AUTOMATICO.bat), que no abre navegador.
' ============================================================
Option Explicit

Dim fso, sh, carpeta
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta

If fso.FileExists(carpeta & "\.env") And fso.FolderExists(carpeta & "\node_modules") Then
    ' Ya instalado: arranque oculto PERO abriendo el navegador al final
    sh.Environment("PROCESS").Item("SILENCIOSO") = "1"
    sh.Environment("PROCESS").Item("ABRIR_DASH") = "1"
    sh.Run "cmd /c """ & carpeta & "\1-INICIAR-AGENTE.bat""", 0, False
Else
    ' Primera vez: asistente visible (una unica vez)
    sh.Run "cmd /c """ & carpeta & "\INSTALAR-AGENTE.bat""", 1, False
End If
