/*
 * SPDX-License-Identifier: GPL-3.0
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 */

import {
    app,
    BrowserWindow,
    BrowserWindowConstructorOptions,
    dialog,
    Menu,
    MenuItemConstructorOptions,
    nativeTheme,
    screen,
    session,
    Tray
} from "electron";
import { rm } from "fs/promises";
import { createHash } from 'crypto';
import { downloadFile } from "./utils/http";
import { existsSync, readFileSync } from 'fs';
import { join } from "path";
import { IpcEvents } from "shared/IpcEvents";
import { isTruthy } from "shared/utils/guards";
import { once } from "shared/utils/once";
import type { SettingsStore } from "shared/utils/SettingsStore";

import { ICON_PATH } from "../shared/paths";
import { createAboutWindow } from "./about";
import { initArRPC } from "./arrpc";
import {
    BrowserUserAgent,
    DATA_DIR,
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    MessageBoxChoice,
    MIN_HEIGHT,
    MIN_WIDTH,
    VENCORD_FILES_DIR,
    VENCORD_THEMES_DIR
} from "./constants";
import { Settings, State, VencordSettings } from "./settings";
import { createSplashWindow } from "./splash";
import { makeLinksOpenExternally } from "./utils/makeLinksOpenExternally";
import { applyDeckKeyboardFix, askToApplySteamLayout, isDeckGameMode } from "./utils/steamOS";
import { downloadVencordFiles, ensureVencordFiles } from "./utils/vencordLoader";

let isQuitting = false;
let tray: Tray;

applyDeckKeyboardFix();

app.on("before-quit", () => {
    isQuitting = true;
});

function getFileHash(filePath) {
    const fileBuffer = readFileSync(filePath);
    const hash = createHash('sha256');
    hash.update(fileBuffer);
    return hash.digest('hex');
}

export let mainWin: BrowserWindow;

function makeSettingsListenerHelpers<O extends object>(o: SettingsStore<O>) {
    const listeners = new Map<(data: any) => void, PropertyKey>();

    const addListener: typeof o.addChangeListener = (path, cb) => {
        listeners.set(cb, path);
        o.addChangeListener(path, cb);
    };
    const removeAllListeners = () => {
        for (const [listener, path] of listeners) {
            o.removeChangeListener(path as any, listener);
        }

        listeners.clear();
    };

    return [addListener, removeAllListeners] as const;
}

const [addSettingsListener, removeSettingsListeners] = makeSettingsListenerHelpers(Settings);
const [addVencordSettingsListener, removeVencordSettingsListeners] = makeSettingsListenerHelpers(VencordSettings);

function initTray(win: BrowserWindow) {
    const onTrayClick = () => {
        if (Settings.store.clickTrayToShowHide && win.isVisible()) win.hide();
        else win.show();
    };
    const trayMenu = Menu.buildFromTemplate([
        {
            label: "Open",
            click() {
                win.show();
            }
        },
        {
            label: "About",
            click: createAboutWindow
        },
        {
            label: "Repair Vencord",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Reset LowTaperFadeCord",
            async click() {
                await clearData(win);
            }
        },
        {
            type: "separator"
        },
        {
            label: "Restart",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Quit",
            click() {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray = new Tray(ICON_PATH);
    tray.setToolTip("LowTaperFadeCord");
    tray.setContextMenu(trayMenu);
    tray.on("click", onTrayClick);
}

async function clearData(win: BrowserWindow) {
    const { response } = await dialog.showMessageBox(win, {
        message: "Are you sure you want to reset LowTaperFadeCord?",
        detail: "This will log you out, clear caches and reset all your settings!\n\LowTaperFadeCord will automatically restart after this operation.",
        buttons: ["Yes", "No"],
        cancelId: MessageBoxChoice.Cancel,
        defaultId: MessageBoxChoice.Default,
        type: "warning"
    });

    if (response === MessageBoxChoice.Cancel) return;

    win.close();

    await win.webContents.session.clearStorageData();
    await win.webContents.session.clearCache();
    await win.webContents.session.clearCodeCaches({});
    await rm(DATA_DIR, { force: true, recursive: true });

    app.relaunch();
    app.quit();
}

type MenuItemList = Array<MenuItemConstructorOptions | false>;

function initMenuBar(win: BrowserWindow) {
    const isWindows = process.platform === "win32";
    const isDarwin = process.platform === "darwin";
    const wantCtrlQ = !isWindows || VencordSettings.store.winCtrlQ;

    const subMenu = [
        {
            label: "About LowTaperFadeCord",
            click: createAboutWindow
        },
        {
            label: "Force Update Vencord",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            },
            toolTip: "LowTaperFadeCord will automatically restart after this operation"
        },
        {
            label: "Reset LowTaperFadeCord",
            async click() {
                await clearData(win);
            },
            toolTip: "LowTaperFadeCord will automatically restart after this operation"
        },
        {
            label: "Relaunch",
            accelerator: "CmdOrCtrl+Shift+R",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        ...(!isDarwin
            ? []
            : ([
                  {
                      type: "separator"
                  },
                  {
                      label: "Settings",
                      accelerator: "CmdOrCtrl+,",
                      async click() {
                          mainWin.webContents.executeJavaScript(
                              "Vencord.Webpack.Common.SettingsRouter.open('My Account')"
                          );
                      }
                  },
                  {
                      type: "separator"
                  },
                  {
                      role: "hide"
                  },
                  {
                      role: "hideOthers"
                  },
                  {
                      role: "unhide"
                  },
                  {
                      type: "separator"
                  }
              ] satisfies MenuItemList)),
        {
            label: "Quit",
            accelerator: wantCtrlQ ? "CmdOrCtrl+Q" : void 0,
            visible: !isWindows,
            role: "quit",
            click() {
                app.quit();
            }
        },
        isWindows && {
            label: "Quit",
            accelerator: "Alt+F4",
            role: "quit",
            click() {
                app.quit();
            }
        },
        // See https://github.com/electron/electron/issues/14742 and https://github.com/electron/electron/issues/5256
        {
            label: "Zoom in (hidden, hack for Qwertz and others)",
            accelerator: "CmdOrCtrl+=",
            role: "zoomIn",
            visible: false
        }
    ] satisfies MenuItemList;

    const menu = Menu.buildFromTemplate([
        {
            label: "LowTaperFadeCord",
            role: "appMenu",
            submenu: subMenu.filter(isTruthy)
        },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" }
    ]);

    Menu.setApplicationMenu(menu);
}

function getWindowBoundsOptions(): BrowserWindowConstructorOptions {
    // We want the default window behaivour to apply in game mode since it expects everything to be fullscreen and maximized.
    if (isDeckGameMode) return {};

    const { x, y, width, height } = State.store.windowBounds ?? {};

    const options = {
        width: width ?? DEFAULT_WIDTH,
        height: height ?? DEFAULT_HEIGHT
    } as BrowserWindowConstructorOptions;

    const storedDisplay = screen.getAllDisplays().find(display => display.id === State.store.displayid);

    if (x != null && y != null && storedDisplay) {
        options.x = x;
        options.y = y;
    }

    if (!Settings.store.disableMinSize) {
        options.minWidth = MIN_WIDTH;
        options.minHeight = MIN_HEIGHT;
    }

    return options;
}

function getDarwinOptions(): BrowserWindowConstructorOptions {
    const options = {
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 10, y: 10 }
    } as BrowserWindowConstructorOptions;

    const { splashTheming, splashBackground } = Settings.store;
    const { macosTranslucency } = VencordSettings.store;

    if (macosTranslucency) {
        options.vibrancy = "sidebar";
        options.backgroundColor = "#ffffff00";
    } else {
        if (splashTheming) {
            options.backgroundColor = splashBackground;
        } else {
            options.backgroundColor = nativeTheme.shouldUseDarkColors ? "#313338" : "#ffffff";
        }
    }

    return options;
}

function initWindowBoundsListeners(win: BrowserWindow) {
    const saveState = () => {
        State.store.maximized = win.isMaximized();
        State.store.minimized = win.isMinimized();
    };

    win.on("maximize", saveState);
    win.on("minimize", saveState);
    win.on("unmaximize", saveState);

    const saveBounds = () => {
        State.store.windowBounds = win.getBounds();
        State.store.displayid = screen.getDisplayMatching(State.store.windowBounds).id;
    };

    win.on("resize", saveBounds);
    win.on("move", saveBounds);
}

function initSettingsListeners(win: BrowserWindow) {
    addSettingsListener("tray", enable => {
        if (enable) initTray(win);
        else tray?.destroy();
    });
    addSettingsListener("disableMinSize", disable => {
        if (disable) {
            // 0 no work
            win.setMinimumSize(1, 1);
        } else {
            win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);

            const { width, height } = win.getBounds();
            win.setBounds({
                width: Math.max(width, MIN_WIDTH),
                height: Math.max(height, MIN_HEIGHT)
            });
        }
    });

    addVencordSettingsListener("macosTranslucency", enabled => {
        if (enabled) {
            win.setVibrancy("sidebar");
            win.setBackgroundColor("#ffffff00");
        } else {
            win.setVibrancy(null);
            win.setBackgroundColor("#ffffff");
        }
    });

    addSettingsListener("enableMenu", enabled => {
        win.setAutoHideMenuBar(enabled ?? false);
    });

    addSettingsListener("spellCheckLanguages", languages => initSpellCheckLanguages(win, languages));
}

async function initSpellCheckLanguages(win: BrowserWindow, languages?: string[]) {
    languages ??= await win.webContents.executeJavaScript("[...new Set(navigator.languages)]").catch(() => []);
    if (!languages) return;

    const ses = session.defaultSession;

    const available = ses.availableSpellCheckerLanguages;
    const applicable = languages.filter(l => available.includes(l)).slice(0, 5);
    if (applicable.length) ses.setSpellCheckerLanguages(applicable);
}

function initSpellCheck(win: BrowserWindow) {
    win.webContents.on("context-menu", (_, data) => {
        win.webContents.send(IpcEvents.SPELLCHECK_RESULT, data.misspelledWord, data.dictionarySuggestions);
    });

    initSpellCheckLanguages(win, Settings.store.spellCheckLanguages);
}

function createMainWindow() {
    // Clear up previous settings listeners
    removeSettingsListeners();
    removeVencordSettingsListeners();

    const { staticTitle, transparencyOption, enableMenu, customTitleBar } = Settings.store;

    const { frameless, transparent } = VencordSettings.store;

    const noFrame = frameless === true || customTitleBar === true;

    const win = (mainWin = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            sandbox: false,
            contextIsolation: true,
            devTools: true,
            preload: join(__dirname, "preload.js"),
            spellcheck: true,
            // disable renderer backgrounding to prevent the app from unloading when in the background
            backgroundThrottling: false
        },
        icon: ICON_PATH,
        frame: !noFrame,
        ...(transparent && {
            transparent: true,
            backgroundColor: "#00000000"
        }),
        ...(transparencyOption &&
            transparencyOption !== "none" && {
                backgroundColor: "#00000000",
                backgroundMaterial: transparencyOption
            }),
        // Fix transparencyOption for custom discord titlebar
        ...(customTitleBar &&
            transparencyOption &&
            transparencyOption !== "none" && {
                transparent: true
            }),
        ...(staticTitle && { title: "LowTaperFadeCord" }),
        ...(process.platform === "darwin" && getDarwinOptions()),
        ...getWindowBoundsOptions(),
        autoHideMenuBar: enableMenu
    }));
    win.setMenuBarVisibility(false);
    if (process.platform === "darwin" && customTitleBar) win.setWindowButtonVisibility(false);

    win.on("close", e => {
        const useTray = !isDeckGameMode && Settings.store.minimizeToTray !== false && Settings.store.tray !== false;
        if (isQuitting || (process.platform !== "darwin" && !useTray)) return;

        e.preventDefault();

        if (process.platform === "darwin") app.hide();
        else win.hide();

        return false;
    });

    if (Settings.store.staticTitle) win.on("page-title-updated", e => e.preventDefault());

    initWindowBoundsListeners(win);
    if (!isDeckGameMode && (Settings.store.tray ?? true) && process.platform !== "darwin") initTray(win);
    initMenuBar(win);
    makeLinksOpenExternally(win);
    initSettingsListeners(win);
    initSpellCheck(win);

    win.webContents.setUserAgent(BrowserUserAgent);

    const subdomain =
        Settings.store.discordBranch === "canary" || Settings.store.discordBranch === "ptb"
            ? `${Settings.store.discordBranch}.`
            : "";

    win.loadURL(`https://${subdomain}discord.com/app`);

    return win;
}

async function downloadLTFCTheme(LTFThemePath){
    const GHURL = "https://raw.githubusercontent.com/kxtzownsu/LowTaperFadeCord/refs/heads/main/lowtaperfadecord.theme.css";
    const LTFThemePathTMP = LTFThemePath + ".tmp";

    // now normally I'd *never* use try-catch, but we don't really wanna crash here, 
    // and if the theme doesn't apply or download, I do want to know why it didn't

    // on a second look, to anyone else this looks SUPER chatgpt'd and I promise it isn't
    // I don't even have a GPT account, and last I checked you need an account to use GPT
    if (existsSync(LTFThemePath)) {
        try {
            
            // this is what happens when its midmight and I don't know what to name my variables
            const LocalHash = getFileHash(LTFThemePath);
            const GHHash = await new Promise((resolve, reject) => {
                downloadFile(GHURL, LTFThemePathTMP, {}, { retryOnNetworkError: true })
                    .then(() => {
                        const data = readFileSync(LTFThemePathTMP);
                        const GHHash = createHash('sha256').update(data).digest('hex');
                        resolve(GHHash);
                    })
                    .catch(reject);
            });
            
            // we don't wanna override the theme if we're running on dev mode, so only run this check on non-dev builds
            if (! IS_DEV) {
                if (LocalHash !== GHHash) {
                    console.log("THEME: Hashes don't match, re-downloading theme");
                    downloadFile(GHURL, LTFThemePath, {}, { retryOnNetworkError: true });
                }
            }
        
        // this is what I meant above when I said that I wanted to tell why a download failed
        } catch (error) {
            console.error("THEME: Failed to check/update theme:", error);
        }
    } else {
        console.log("THEME: LTFCTheme not found locally, downloading...");
        downloadFile(GHURL, LTFThemePath, {}, { retryOnNetworkError: true });

        // if the theme is downloaded successfully, enable it without overriding other userthemes
        if (existsSync(LTFThemePath)) {
            mainWin.webContents.executeJavaScript(`
                (async () => {
                    const themes = Vencord.Settings.enabledThemes || [];
                    if (!themes.includes("lowtaperfadecord.theme.css")) {
                        Vencord.Settings.enabledThemes = ["lowtaperfadecord.theme.css", ...themes];
                        console.log("Enabled theme: lowtaperfadecord.theme.css");
                    }
                })();
            `);
        }
    }
}

const runVencordMain = once(() => require(join(VENCORD_FILES_DIR, "vencordDesktopMain.js")));

export async function createWindows() {
    const startMinimized = process.argv.includes("--start-minimized");
    const splash = createSplashWindow(startMinimized);
    // SteamOS letterboxes and scales it terribly, so just full screen it
    if (isDeckGameMode) splash.setFullScreen(true);
    await ensureVencordFiles();
    runVencordMain();

    mainWin = createMainWindow();

    mainWin.webContents.on("did-finish-load", () => {
        splash.destroy();

        if (!startMinimized) {
            mainWin!.show();
            if (State.store.maximized && !isDeckGameMode) mainWin!.maximize();
        }

        if (isDeckGameMode) {
            // always use entire display
            mainWin!.setFullScreen(true);

            askToApplySteamLayout(mainWin);
        }

        mainWin.once("show", () => {
            if (State.store.maximized && !mainWin!.isMaximized() && !isDeckGameMode) {
                mainWin!.maximize();
            }
        });
    });

    initArRPC();

    const LTFThemePath = join(VENCORD_THEMES_DIR, "lowtaperfadecord.theme.css");
    downloadLTFCTheme(LTFThemePath);
}
