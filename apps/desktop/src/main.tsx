import "@meridian/design-system/tokens.css";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Island } from "./island/Island";
import { mock } from "./lib/mock";
import {
  answerApproval,
  boot,
  cancelSession,
  getState,
  openPanel,
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

// Test hook: lets end-to-end tests drive the real store and components.
Object.assign(window, {
  __meridian: {
    showPreview,
    getState,
    startSession,
    answerApproval,
    cancelSession,
    sendChat,
    sendAgentChat,
    selectEngine,
    setAgentMode,
    openPanel,
    updateSettings,
  },
  __mock: mock,
});
