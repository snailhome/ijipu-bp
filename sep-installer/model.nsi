; 爱扒谱「分离模型包」安装脚本
;
; 为什么单独一个安装包：模型 302 MB + onnxruntime.dll 30 MB，塞进主安装包会让人人都下 330 MB，
; 可只有要用人声分离的人才需要它。装的位置固定是主应用的数据目录，
; 主应用（src-tauri/src/sep.rs）就在那儿找模型和 dll，两边不需要知道对方的安装路径。
;
; 打：node ../scripts/build-model-installer.mjs
; 产物：../dist-model/ijipu-bp-sep-model-setup.exe

Unicode true
!include "MUI2.nsh"

!define APPNAME "爱扒谱 分离模型包"
!define APPID "ijipu-bp-sep-model"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"

Name "${APPNAME}"
OutFile "..\dist-model\ijipu-bp-sep-model-setup.exe"
InstallDir "$APPDATA\com.ijipu.bp\models"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_LINK "打开模型发布页（HuggingFace）"
!define MUI_FINISHPAGE_LINK_LOCATION "https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "分离模型（htdemucs，MIT）" SecModel
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; payload 由 scripts/build-model-installer.mjs 从 .cache 里拷过来
  File "payload\htdemucs_ft_vocals.onnx"
  File "payload\onnxruntime.dll"
  FileOpen $0 "$INSTDIR\model.version" w
  FileWrite $0 "htdemucs-ft-vocals-onnx / opset17 / MIT$\r$\n"
  FileClose $0

  ; 卸载信息（让它在「应用和功能」里看得见、能卸）
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "1.0.0"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "iJipu BP"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall-model.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall-model.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\htdemucs_ft_vocals.onnx"
  Delete "$INSTDIR\onnxruntime.dll"
  Delete "$INSTDIR\model.version"
  Delete "$INSTDIR\uninstall-model.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
