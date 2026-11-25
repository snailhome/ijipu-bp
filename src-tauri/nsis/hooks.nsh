/**
 * nsis/hooks.nsh — 爱扒谱（iJipu BP）NSIS 安装钩子（adj1315）
 *
 * ## 只做一件事：把 `.jps` 的**文件类型图标**指到安装目录里的 `jps.ico`
 *
 * 用户口径（2026-11-18）：「jps 文件的关联图标用 Logo.png（通用 123 标记），
 * 应用图标用各自的 Logo-xx.png」。
 *
 * 为什么需要这个钩子：Tauri 的 NSIS 模板（`APP_ASSOCIATE`）把 ProgID 的
 * `DefaultIcon` 写成 `$INSTDIR\<主程序>.exe,0` —— 也就是**用应用图标当文件图标**。
 * 爱扒谱的应用图标是「123BP」，可 `.jps` 是**通用简谱工程文件**，不该带某个产品的字样；
 * 而且 `.jps` 同时被 iJipu 与爱扒谱注册，谁最后装谁生效 —— 两边都写同一张通用图，结果才一致。
 *
 * 生效顺序：模板在 `Section Install` 里先写关联，再 `!insertmacro NSIS_HOOK_POSTINSTALL`
 * （生成出来的 `installer.nsi` 里分别是 652 行与 712 行），所以这里覆写就是最终值。
 *
 * `jps.ico` 由 `tauri.conf.json` 的 `bundle.resources` 从 `icons/jps.ico` 拷到 `$INSTDIR\jps.ico`
 * （源图 = `D:\Coding\JianpuScript\矢量图\Logo.png`，256/128/64/48/32/24/16 七档）。
 *
 * ⚠️ 本文件含**中文字符串常量**，必须保存成**带 BOM 的 UTF-8**：makensis 对无 BOM 的文件
 *    按 ANSI 解析，中文会变乱码（`installer.nsi` / `utils.nsh` 都是带 BOM 的）。
 * ⚠️ ProgID 的取值来自 `tauri.conf.json` 里 `fileAssociations[].name`，**两边必须一致**，
 *    改了一处就得改另一处（否则写到一个没人用的键上，图标不会变）。
 */
!define IJIPUBP_PROGID "iJipu 简谱脚本"
!define IJIPUBP_ICON "jps.ico"

!macro NSIS_HOOK_POSTINSTALL
  ; 用户 2026-11-25 统一口径：桌面/开始菜单快捷方式 =「爱扒谱・iJipu BP」
  Delete "$DESKTOP\爱扒谱・iJipu BP.lnk"
  CreateShortcut "$DESKTOP\爱扒谱・iJipu BP.lnk" "$INSTDIR\ijipu-bp.exe" "" "$INSTDIR\ijipu-bp.exe" 0 SW_SHOWNORMAL "" "爱扒谱・iJipu BP"
  IfFileExists "$SMPROGRAMS\iJipuBP.lnk" 0 +2
    Rename "$SMPROGRAMS\iJipuBP.lnk" "$SMPROGRAMS\爱扒谱・iJipu BP.lnk"
  IfFileExists "$SMPROGRAMS\iJipuBP\iJipuBP.lnk" 0 +2
    Rename "$SMPROGRAMS\iJipuBP\iJipuBP.lnk" "$SMPROGRAMS\iJipuBP\爱扒谱・iJipu BP.lnk"

  ; 安装模式是 currentUser（未设 installMode ⇒ 默认），关联写在 HKCU；
  ; 这里显式写 HKCU 而不是 SHCTX，避免与卸载器的 SetShellVarContext 时序耦合。
  IfFileExists "$INSTDIR\${IJIPUBP_ICON}" 0 ijipu_bp_jps_icon_done
    WriteRegStr HKCU "Software\Classes\${IJIPUBP_PROGID}\DefaultIcon" "" "$INSTDIR\${IJIPUBP_ICON},0"
  ijipu_bp_jps_icon_done:
  ; 资源管理器会缓存文件类型图标，不通知就要重启或重新登录才看到新图。
  System::Call "shell32::SHChangeNotify(i, i, i, i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\爱扒谱・iJipu BP.lnk"
  Delete "$SMPROGRAMS\爱扒谱・iJipu BP.lnk"
  Delete "$SMPROGRAMS\iJipuBP\爱扒谱・iJipu BP.lnk"
!macroend
