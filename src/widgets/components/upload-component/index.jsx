/**
 * UPLOAD-COMPONENT/INDEX.JSX - Upload Component Entry Point
 * 
 * This file is the entry point for the Upload widget used in ChatGPT.
 * It renders the UploadComponent into the DOM element with id "upload-component-root"
 * and exports it for use by the MCP server.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import "../../styles/audio-widgets.css";
import UploadComponent from "./upload-component";

function renderComponent() {
  console.log("[UPLOAD-COMPONENT] Starting to render...");
  console.log("[UPLOAD-COMPONENT] Document ready state:", document.readyState);
  console.log("[UPLOAD-COMPONENT] Window openai available:", !!window.openai);

  const rootElement = document.getElementById("upload-component-root");
  console.log("[UPLOAD-COMPONENT] Root element found:", !!rootElement);

  if (!rootElement) {
    console.error("[UPLOAD-COMPONENT] upload-component-root element not found");
    // Try to find any div and log it
    const allDivs = Array.from(document.querySelectorAll('div'));
    console.log("[UPLOAD-COMPONENT] All divs in document:", allDivs.map(d => ({ id: d.id, className: d.className })));
    // Retry after a short delay
    setTimeout(renderComponent, 100);
    return;
  }

  try {
    console.log("[UPLOAD-COMPONENT] Creating React root...");
    const root = createRoot(rootElement);
    console.log("[UPLOAD-COMPONENT] Rendering UploadComponent...");
    root.render(React.createElement(UploadComponent));
    console.log("[UPLOAD-COMPONENT] Render complete!");
  } catch (error) {
    console.error("[UPLOAD-COMPONENT] Error rendering UploadComponent:", error);
    rootElement.innerHTML = `<div style="padding: 20px; color: red; font-family: sans-serif;">Error loading upload component: ${error.message}<br/><pre>${error.stack}</pre></div>`;
  }
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderComponent);
} else {
  renderComponent();
}

export { UploadComponent };
export { UploadComponent as App };
export default UploadComponent;

