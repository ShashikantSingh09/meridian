import "@fontsource-variable/inter/opsz.css";
import "@meridian/design-system/tokens.css";
import "@meridian/design-system/themes.css";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./glass.css";
import { Island } from "./island/Island";
import { mock } from "./lib/mock";
import {
  answerApproval,
  boot,
  cancelSession,
  captureScreen,
  feel,
  closePanel,
  discardCapture,
  dismissError,
  dismissNotice,
  getState,
  openPanel,
  pushNotice,
  refreshActivity,
  refreshCharge,
  refreshIntegrations,
  selectEngine,
  sendAgentChat,
  sendChat,
  setAgentMode,
  setHovered,
  showPreview,
  startSession,
  updateSettings,
} from "./lib/store";
import { bridge } from "./lib/bridge";
import { watchTheme } from "./lib/theme";
import { refreshNotes, wireNotes } from "./lib/notes";
import { endConversation, say, startVoice, wireVoice } from "./lib/voice";

// A file or link dropped on the island would otherwise load in its place, and every page here can
// reach the app's commands. The island's own drag uses the pointer, not this, so nothing is lost.
for (const kind of ["dragover", "drop"] as const) addEventListener(kind, (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(<Island />);

wireVoice();
wireNotes();
watchTheme(() => getState().settings);

void boot();

// Test hook: lets end-to-end tests drive the real store and components. Dev builds
// only, so a release exposes nothing beyond its normal interface.
if (import.meta.env.DEV) Object.assign(window, {
  __meridian: {
    showPreview,
    getState,
    startSession,
    answerApproval,
    cancelSession,
    captureScreen,
    feel,
    bridge,
    say,
    startVoice,
    endConversation,
    closePanel,
    discardCapture,
    dismissError,
    dismissNotice,
    sendChat,
    sendAgentChat,
    selectEngine,
    setAgentMode,
    openPanel,
    pushNotice,
    refreshActivity,
    refreshCharge,
    refreshIntegrations,
    refreshNotes,
    setHovered,
    updateSettings,
  },
  __mock: mock,
});
