/**
 * AUDIO-EDITOR/INDEX.JSX - Audio Editor Component Entry Point
 * 
 * This file is the entry point for the Audio Editor widget used in ChatGPT.
 * It renders the AudioEditor component into the DOM element with id "audio-editor-root"
 * and exports it for use by the MCP server.
 * 
 * This file is bundled and served by the MCP server as a widget resource.
 */

import { createRoot } from "react-dom/client";
import "../../styles/audio-widgets.css";
import AudioEditor from "./audio-editor";

createRoot(document.getElementById("audio-editor-root")).render(<AudioEditor />);

export { AudioEditor };
export { AudioEditor as App };
export default AudioEditor;
