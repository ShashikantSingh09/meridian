import "@fontsource-variable/inter/opsz.css";
import "@meridian/design-system/tokens.css";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Island } from "./island/Island";
import { mock } from "./lib/mock";
import {
  answerApproval,
  boot,
  cancelSession,
  captureScreen,
  closePanel,
  discardCapture,
  dismissError,
  dismissNotice,
  getState,
  openPanel,
  pushNotice,
  selectEngine,
  sendAgentChat,
  sendChat,
  setAgentMode,
  showPreview,
  startSession,
  updateSettings,
} from "./lib/store";

createRoot(document.getElementById("root")!).render(<Island />);

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
    updateSettings,
  },
  __mock: mock,
});
