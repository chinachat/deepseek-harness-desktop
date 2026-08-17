; ============================================================================
; Custom NSIS include for the DeepSeek Harness desktop installer.
;
; Purpose:
;   1. Keep the app install folder name stable (APP_FILENAME).
;   2. Enable the "Show details" pane on the install progress page so the
;      install process is visible step-by-step (electron-builder sets
;      `ShowInstDetails nevershow` and `SetDetailsPrint none` by default,
;      which hides everything behind a bare progress bar).
;
; How electron-builder uses this file:
;   This file is `!include`d into the generated installer header, i.e. BEFORE
;   `common.nsh` (which sets `ShowInstDetails nevershow`) and before the
;   sections run. Macros we define here are then invoked from electron-builder's
;   `installer.nsi` via `!ifmacrodef ... !insertmacro ...` hooks:
;
;     - customHeader : inserted right after the MUI pages are declared.
;     - customInit   : inserted inside Function .onInit.
;     - customInstall: inserted at the end of the install section.
; ============================================================================

; Override the application folder name used for the install directory.
; When the user picks another drive in the directory page, the installer
; appends this folder name (see assistedInstaller.nsh sanitize logic), and it
; is also used as the default installation sub-folder (see multiUser.nsh).
!undef APP_FILENAME
!define APP_FILENAME "DeepSeek Harness Desktop"

; ----------------------------------------------------------------------------
; Re-enable the expandable "Show details" pane. common.nsh set it to
; `nevershow`, which also removes the Show/Hide button entirely. This macro
; runs AFTER common.nsh, so it wins.
; ----------------------------------------------------------------------------
!macro customHeader
  ShowInstDetails show
!macroend

; ----------------------------------------------------------------------------
; At install time the details log is additionally silenced with
; `SetDetailsPrint none`. Re-arm it here at onInit so the detail window can be
; populated as soon as the install section begins, and keep milestone text
; visible throughout.
; ----------------------------------------------------------------------------
!macro customInit
  ; listonly: show the list (progress lines) without duplicating them as a
  ; plain-text stream. Safe to call before the details pane exists.
  SetDetailsPrint listonly
  DetailPrint "准备安装 $(^Name) …"
!macroend

; ----------------------------------------------------------------------------
; Runs at the end of the install section (after files are copied and
; shortcuts/registry written). The bulk File/r copy is intentionally quiet
; (electron-builder sets SetDetailsPrint none there); we print a clear
; milestone trail here so the details pane shows the completed steps.
; ----------------------------------------------------------------------------
!macro customInstall
  SetDetailsPrint listonly
  DetailPrint "应用文件已复制到 $INSTDIR"
  DetailPrint "快捷方式与注册表已写入"
  DetailPrint "安装完成"
!macroend
