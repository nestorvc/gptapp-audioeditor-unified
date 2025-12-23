/**
 * UPLOAD-COMPONENT.JSX - Audio Upload Component
 * 
 * Component for uploading audio files. When a file is uploaded, it transitions
 * to the AudioEditor component by calling the appropriate MCP tool.
 */

import React, { useState, useRef } from "react";
import "../../styles/audio-widgets.css";
import { useToolOutput, useCallTool, useOpenAIGlobals, useSendFollowUpMessage } from "../../hooks/useOpenAI";
import { trackFileUploaded } from "../../utils/analytics";

const sanitizeFileName = (rawName, fallback = "audio") => {
  if (!rawName || typeof rawName !== "string") {
    return fallback;
  }

  const sanitized = rawName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim()
    .replace(/\s+/g, "-");

  return sanitized.length > 0 ? sanitized : fallback;
};

export function UploadComponent() {
  const toolOutput = useToolOutput();
  const { callTool } = useCallTool();
  const sendFollowUpMessage = useSendFollowUpMessage();
  const openAIGlobals = useOpenAIGlobals();
  const isRingtoneMode = toolOutput?.mode === "ringtone";
  
  const [uploadError, setUploadError] = useState(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileUpload = async (event) => {
    const inputPath = event?.target?.value ?? "";
    if (typeof inputPath === 'string' && inputPath.includes('/mnt/data/')) {
      setUploadError("Looks like that file was attached in the ChatGPT chat. Please upload the audio directly through this screen.");
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await processFile(file, 'button');
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      await processFile(files[0], 'drag-drop');
    }
  };

  const processFile = async (file, source = 'button') => {
    setUploadError(null);
    setIsProcessing(true);

    if (!file) {
      setIsProcessing(false);
      return;
    }

    if (typeof file.path === 'string' && file.path.includes('/mnt/data/')) {
      setUploadError("Files attached in the ChatGPT chat can't be loaded. Please choose the audio file using this uploader.");
      setIsProcessing(false);
      return;
    }

    // Validate file type
    const validAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm'];
    const validExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    
    if (!validAudioTypes.includes(file.type) && !validExtensions.includes(fileExtension)) {
      setUploadError('Please upload a valid audio file (MP3, WAV, M4A, AAC, OGG, or WebM)');
      setIsProcessing(false);
      return;
    }

    try {
      // Track file upload event
      const sanitizedFileName = sanitizeFileName(file.name.replace(/\.[^/.]+$/, ""), "audio-file");
      trackFileUploaded({
        upload_method: source,
        file_type: file.type || fileExtension,
        file_size: file.size,
        file_name: sanitizedFileName,
      });

      // Upload file to S3 first to get a public URL
      const runtimeApiUrl = typeof window !== 'undefined' && window.__API_BASE_URL__;
      if (!runtimeApiUrl) {
        setUploadError("API URL not available. Please try again.");
        setIsProcessing(false);
        return;
      }

      // Get presigned URL from server
      const presignedUrlResponse = await fetch(`${runtimeApiUrl.replace(/\/$/, "")}/api/s3-presigned-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || "audio/mpeg",
        }),
      });

      if (!presignedUrlResponse.ok) {
        throw new Error("Failed to get presigned upload URL");
      }

      const { uploadUrl, publicUrl } = await presignedUrlResponse.json();

      // Upload file directly to S3
      const s3UploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type || "audio/mpeg",
        },
      });

      if (!s3UploadResponse.ok) {
        throw new Error("Failed to upload file to S3");
      }

      // Request opening the editor with the uploaded file URL
      const toolName = isRingtoneMode 
        ? "audio.open_ringtone_editor_with_file"
        : "audio.open_audio_editor_with_file";
      
      await callTool(toolName, {
        audioUrl: publicUrl,
      });

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      setUploadError(error?.message || "Failed to process file. Please try again.");
      setIsProcessing(false);
    }
  };

  const title = isRingtoneMode ? "Upload Ringtone File" : "Upload Audio File";

  return (
    <div className="ringtone-editor">
      {/* Header */}
      <div className="ringtone-header">
        <div className="upload-title-container">            
          <svg className="upload-title-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 5C8.55228 5 9 5.44772 9 6V18C9 18.5523 8.55228 19 8 19C7.44772 19 7 18.5523 7 18V6C7 5.44772 7.44772 5 8 5ZM16 7C16.5523 7 17 7.44772 17 8V16C17 16.5523 16.5523 17 16 17C15.4477 17 15 16.5523 15 16V8C15 7.44772 15.4477 7 16 7ZM12 8.5C12.5523 8.5 13 8.94772 13 9.5V14.5C13 15.0523 12.5523 15.5 12 15.5C11.4477 15.5 11 15.0523 11 14.5V9.5C11 8.94772 11.4477 8.5 12 8.5ZM4 9.5C4.55228 9.5 5 9.94772 5 10.5V13.5C5 14.0523 4.55228 14.5 4 14.5C3.44772 14.5 3 14.0523 3 13.5V10.5C3 9.94772 3.44772 9.5 4 9.5ZM20 9.5C20.5523 9.5 21 9.94772 21 10.5V13.5C21 14.0523 20.5523 14.5 20 14.5C19.4477 14.5 19 14.0523 19 13.5V10.5C19 9.94772 19.4477 9.5 20 9.5Z" fill="currentColor"/>
          </svg>
          <h2 className="upload-title">{title}</h2>
        </div>
      </div>
      
      {/* Waveform Section - Upload UI */}
      <div className="waveform-container">
        <input
          ref={fileInputRef}
          id="audio-file-input"
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm"
          onChange={handleFileUpload}
          style={{ display: 'none' }}
          aria-label="Upload audio file or Drag-n-drop here"
          disabled={isProcessing}
        />
        <div 
          className={`upload-area ${isDraggingOver ? 'drag-over' : ''} ${isProcessing ? 'processing' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={(e) => {
            e.preventDefault();
            if (!isProcessing && fileInputRef.current) {
              fileInputRef.current.click();
            }
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !isProcessing) {
              e.preventDefault();
              if (fileInputRef.current) {
                fileInputRef.current.click();
              }
            }
          }}
        >            
          {isProcessing ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <p className="upload-description">Processing file...</p>
            </>
          ) : (
            <>
              <p className="upload-description">
                {isDraggingOver ? 'Drop your audio file here' : (
                  <>
                    <b>Drag-n-drop</b> or <b>choose an audio file</b> to edit
                  </>
                )}
              </p>
              <p className="upload-hint">Supports MP3, WAV, M4A, AAC, OGG, and WebM</p>
            </>
          )}
          {uploadError && (
            <div className="upload-error" role="alert">
              {uploadError}
            </div>
          )}
        </div>
      </div>

      {/* Submit Container - Upload Button */}
      <div className="submit-container">
        <button 
          className="generate-button"
          onClick={(e) => {
            e.preventDefault();
            if (!isProcessing && fileInputRef.current) {
              fileInputRef.current.click();
            }
          }}
          disabled={isProcessing}
        >
          {isProcessing ? "Processing..." : "Select File or Drag-n-drop"}
        </button>
      </div>
    </div>
  );
}

export default UploadComponent;

