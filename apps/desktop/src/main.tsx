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
