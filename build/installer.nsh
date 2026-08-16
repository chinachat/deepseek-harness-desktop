; Override the application folder name used for the install directory.
; When the user picks another drive in the directory page, the installer
; appends this folder name (see assistedInstaller.nsh sanitize logic), and it
; is also used as the default installation sub-folder (see multiUser.nsh).
!undef APP_FILENAME
!define APP_FILENAME "DeepSeek Harness Desktop"