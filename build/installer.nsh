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
  ; installSection.nsh switches detail printing OFF in non-silent mode, which is
  ; why the details pane below the progress bar used to stay blank. Printing the
  ; report here, before that happens, is what puts real content in it.
  SetDetailsPrint both

  DetailPrint "=================================================="
  DetailPrint "  DeepSeek Harness - 安装前检查"
  DetailPrint "=================================================="

  ; Windows version via ntdll!RtlGetVersion, which - unlike GetVersionEx - is
  ; not affected by the compatibility shims that report 6.2 on Windows 10+.
  ; RTL_OSVERSIONINFOW's five DWORD fields are contiguous, so a single 20-byte
  ; read reaches dwBuildNumber.
  ; NOTE: LogicLib is NOT loaded yet at this point in electron-builder's header,
  ; so this macro must use plain NSIS instructions instead of ${If}.
  System::Call 'ntdll::RtlGetVersion(p .r0) i .r1'
  System::Call '*$0(&i4, &i4, &i4, &i4, &i4)'
  Pop $R0 ; dwOSVersionInfoSize
  Pop $R1 ; dwMajorVersion
  Pop $R2 ; dwMinorVersion
  Pop $R3 ; dwBuildNumber
  DetailPrint "[检查] Windows 版本 : $R1.$R2 (build $R3)"

  System::Call 'kernel32::GetCurrentProcess() p .r4'
  System::Call 'kernel32::IsWow64Process(p r4, *i .r5) i .r6'
  StrCmp $R5 "1" dsh_ci_64
    DetailPrint "[检查] 进程架构    : 32 位"
    Goto dsh_ci_arch_done
  dsh_ci_64:
    DetailPrint "[检查] 进程架构    : 64 位"
  dsh_ci_arch_done:

  ; Free space on the target volume. FileFunc.nsh is not in this include chain,
  ; so ask kernel32 directly; GetDiskFreeSpaceExW writes uint64, hence *l.
  StrCmp $INSTDIR "" 0 dsh_ci_have_dir
    StrCpy $INSTDIR "$SYSDIR"
  dsh_ci_have_dir:
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$INSTDIR", *l .r7, *l .r8, *l .r9) i .r0'
  StrCmp $R0 "0" dsh_ci_space_unknown
    System::Int64Op $R7 / 1048576
    Pop $R1
    DetailPrint "[检查] 目标盘可用  : $R1 MB"
    Goto dsh_ci_space_done
  dsh_ci_space_unknown:
    DetailPrint "[检查] 目标盘可用  : 读取失败（已跳过）"
  dsh_ci_space_done:

  ; Report a previous installation that this install will replace.
  ; electron-builder already removes it (installSection.nsh calls
  ; uninstallOldVersion); this only makes the step visible.
  ; The registry keys are guarded because they are not defined in every build
  ; pass, and an unguarded reference becomes warning 6000, which
  ; electron-builder escalates to a hard build error.
  ClearErrors
  StrCpy $R2 ""
  StrCpy $R3 ""
  !ifdef UNINSTALL_REGISTRY_KEY
    ReadRegStr $R2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  !endif
  !ifdef INSTALL_REGISTRY_KEY
    ReadRegStr $R3 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  !endif
  StrCmp $R2 "" dsh_ci_no_prev
    DetailPrint "[检查] 旧版本      : 检测到 $R2，安装时将自动移除"
    Goto dsh_ci_prev_dir
  dsh_ci_no_prev:
    DetailPrint "[检查] 旧版本      : 未检测到（全新安装）"
  dsh_ci_prev_dir:
  StrCmp $R3 "" dsh_ci_prev_done
    DetailPrint "[检查] 旧安装位置  : $R3"
  dsh_ci_prev_done:

  DetailPrint "--------------------------------------------------"
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

; ============================================================================
; Uninstall side
;
; Everything here is wrapped in !ifdef BUILD_UNINSTALLER: electron-builder
; compiles this file twice, and `un.` functions / `un.onInit`-only hooks must
; not leak into the installer pass.
; ============================================================================

!ifdef BUILD_UNINSTALLER

; ----------------------------------------------------------------------------
; Ask whether to remove user data (settings, logs, session caches), then record
; the answer by adding --delete-app-data to $CMDLINE.
;
; This runs from customUnInit, i.e. inside un.onInit and BEFORE the uninstall
; section parses its flags (uninstaller.nsh line ~220), so the flag is picked up
; by the template's own parsing and the template performs the removal. That
; avoids fighting the two things that cannot be done here:
;   * customUnInstallSection lands outside any Section/Function, where NSIS
;     rejects executable commands ("command StrCmp not valid outside Section or
;     Function");
;   * the section-scoped $isDeleteAppData cannot be assigned outside the section
;     that declares it ("Usage: StrCpy" at build time).
;
; Silent uninstalls (/S) never prompt, and always keep user data, so the
; updater's "uninstall the previous version" path stays dialog-free. Upgrades
; pass --updated and also keep user data.
; ----------------------------------------------------------------------------
!macro customUnInit
  Call un.dshMaybePurgeFunc
!macroend

Function un.dshMaybePurgeFunc
  ; --- respect an explicit request -----------------------------------------
  Push $CMDLINE
  Push "--delete-app-data"
  Call un.dshStrContains
  Pop $R0
  StrCmp $R0 "" 0 dsh_purge_end ; already requested: leave the flag alone

  ; --- never prompt during a silent uninstall ------------------------------
  Push $CMDLINE
  Push "/S"
  Call un.dshStrContains
  Pop $R0
  StrCmp $R0 "" 0 dsh_purge_no

  ; --- never touch user data during an upgrade -----------------------------
  Push $CMDLINE
  Push "--updated"
  Call un.dshStrContains
  Pop $R0
  StrCmp $R0 "" 0 dsh_purge_no

  SetShellVarContext current
  StrCpy $R1 "$APPDATA\${APP_FILENAME}"
  IfFileExists "$R1\*.*" 0 dsh_purge_no

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "是否同时删除用户数据？$\r$\n$\r$\n$R1$\r$\n$\r$\n包含设置、日志、会话缓存等。$\r$\n选择「否」会保留这些数据，以后重新安装可继续使用。" \
    /SD IDNO IDNO dsh_purge_no

  ; Fall-through means Yes: hand the decision to the template's own parser,
  ; which runs later in the uninstall section. Appending to $CMDLINE works
  ; because NSIS user variables are unbounded strings.
  StrCpy $R2 "$CMDLINE"
  StrCpy $CMDLINE "$R2 --delete-app-data"
  Goto dsh_purge_end

  dsh_purge_no:
    ; Nothing to do: without the flag the template deletes nothing (its
    ; DELETE_APP_DATA_ON_UNINSTALL define is deliberately never set, so user
    ; data is only ever removed when the user asks for it).

  dsh_purge_end:
FunctionEnd

; ----------------------------------------------------------------------------
; Substring search for the uninstaller (StrFunc.nsh is not in this include
; chain, so StrStr is unavailable).
;   Stack in :  haystack, needle (needle pushed last, i.e. on top)
;   Stack out:  the matched suffix, or "" when absent
; ----------------------------------------------------------------------------
Function un.dshStrContains
  Exch $0
  Exch
  Exch $1
  Push $2
  Push $3

  StrLen $2 $0
  StrCpy $3 0
  un_dsh_sc_loop:
    StrCpy $R2 $1 "" $3
    StrCmp $R2 "" un_dsh_sc_miss
    StrCpy $R3 $R2 $2
    StrCmp $R3 $0 un_dsh_sc_hit
    IntOp $3 $3 + 1
    Goto un_dsh_sc_loop

  un_dsh_sc_hit:
    StrCpy $R2 $R2
    Goto un_dsh_sc_done
  un_dsh_sc_miss:
    StrCpy $R2 ""

  un_dsh_sc_done:
  Pop $3
  Pop $2
  Pop $1
  Exch $0
  Push $R2
  Exch
  Pop $R2
FunctionEnd

!endif ; BUILD_UNINSTALLER
