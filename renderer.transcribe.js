// renderer.transcribe.js — DEMO-ONLY VERSION
// ---------------------------------------------------------
// NO IPC, NO FFprobe, NO queues, NO watch mode,
// NO hamsters, NO metadata, NO presets, NO config.
// ONLY:
//   • Dropdowns already work (leave as-is)
//   • Start + Cancel = hover/press only
//   • One generic sample preview per format
//----------------------------------------------------------

(() => {

  // -------------------------------------------------------
  // DEMO DROPDOWN POPULATION (MATCH REAL APP OPTIONS)
  // -------------------------------------------------------
  function dd(id, options, def) {
    if (!window.setupStyledDropdown || !window.setDropdownValue) return;
    window.setupStyledDropdown(id, options);
    if (def !== undefined) window.setDropdownValue(id, def);
  }

  ready(() => {
    // Engine
    dd("transcribe-engine", [
      { value: "whisper",      label: "Whisper" },
      { value: "whisperx",     label: "WhisperX" },
      { value: "faster_whisper", label: "Faster-Whisper" },
      { value: "openai",       label: "OpenAI Cloud" }
    ], "whisper");

    // Language
    dd("transcribe-language", [
      { value: "auto", label: "Auto Detect" },
      { value: "en",   label: "English" },
      { value: "es",   label: "Spanish" },
      { value: "fr",   label: "French" },
      { value: "de",   label: "German" },
      { value: "it",   label: "Italian" },
      { value: "pt",   label: "Portuguese" },
      { value: "zh",   label: "Chinese" },
      { value: "ja",   label: "Japanese" }
    ], "auto");

    // Accuracy
    dd("transcribe-accuracy-mode", [
      { value: "fast",   label: "Fast" },
      { value: "normal", label: "Normal" },
      { value: "accurate", label: "Accurate" }
    ], "normal");

    // Confidence Threshold
    dd("transcribe-confidence", [
      { value: "none", label: "No Filter" },
      { value: "0.25", label: "25%" },
      { value: "0.50", label: "50%" },
      { value: "0.75", label: "75%" },
      { value: "0.90", label: "90%" }
    ], "none");

    // Output Formats — EXACT REAL OPTIONS
    dd("transcribe-output-formats", [
      { value: "txt",       label: "Plain Text (.txt)" },
      { value: "srt",       label: "SubRip (.srt)" },
      { value: "vtt",       label: "WebVTT (.vtt)" },
      { value: "scc",       label: "Scenarist (.scc)" },
      { value: "xml",       label: "XML Transcript (.xml)" },
      { value: "script",    label: "Scripted (CSV/DOCX)" },
      { value: "finalJson", label: "Final JSON (wrapped)" },
      { value: "burnIn",    label: "Burn-In MP4 (Preview Only)" }
    ], "txt");

    // Timecode style
    dd("transcribe-timecode-style", [
      { value: "ndf", label: "NDF — HH:MM:SS:FF" },
      { value: "df",  label: "DF — HH:MM:SS;FF" },
      { value: "ms",  label: "Milliseconds — HH:MM:SS,mmm" }
    ], "ndf");

    // Translate target languages
    dd("translate-target", [
      { value: "en", label: "English" },
      { value: "es", label: "Spanish" },
      { value: "fr", label: "French" },
      { value: "de", label: "German" },
      { value: "pt", label: "Portuguese" },
      { value: "zh", label: "Chinese" },
      { value: "ja", label: "Japanese" }
    ], "en");
  });
  
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else fn();
  }

  // -------------------------------------------------------
  // FIX 1 — Disable ALL Transcribe actions (Start/Cancel)
  // -------------------------------------------------------
  ready(() => {
    const start = document.getElementById("start-transcribe");
    const cancel = document.getElementById("cancel-transcribe");

    if (start) {
      start.onclick = () => { /* demo-only: no action */ };
    }
    if (cancel) {
      cancel.onclick = () => { /* demo-only: no action */ };
    }
  });

  // -------------------------------------------------------
  // FIX 2 — REPLACE preview logic with static samples
  // -------------------------------------------------------

  function sampleTXT() {
    return `Welcome to Lead AE. I am here to Assist.`;
  }

  function sampleSRT() {
    return `1
00:00:01,000 --> 00:00:05,000
Welcome to Lead AE. I am here to Assist.
`;
  }

  function sampleVTT() {
    return `WEBVTT

00:00:01.000 --> 00:00:05.000
Welcome to Lead AE. I am here to Assist.
`;
  }

  function sampleJSON() {
    return JSON.stringify({
      segments: [
        {
          start: 1.0,
          end: 5.0,
          text: "Welcome to Lead AE. I am here to Assist."
        }
      ]
    }, null, 2);
  }

  function sampleXML() {
    return `<transcript>
  <cue start="00:00:01:00" end="00:00:05:00">
    Welcome to Lead AE. I am here to Assist.
  </cue>
</transcript>`;
  }

  function sampleSCRIPT() {
    return `Start,End,Speaker,Text
00:00:01.000,00:00:05.000,SPEAKER,Welcome to Lead AE. I am here to Assist.`;
  }

  // -------------------------------------------------------
  // SCC requires correct SCC formatting:
  //   SCC header + 29.97 DF timecode + PAC + text
  //
  // We'll produce a valid demo line:
  //   Scenarist_SCC V1.0
  //   00:00:01;00 9420  –> PAC for Row 15, no indent
  //   followed by hex for text.
  //
  // ASCII text -> hex (uppercase)
  // -------------------------------------------------------

  function asciiToHex(str) {
    return str.split("")
      .map(c => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(" ")
      .toUpperCase();
  }

  function sampleSCC() {
    const text = "Welcome to Lead AE. I am here to Assist.";
    const hex = asciiToHex(text);
    // PAC 9420 = row 15, white, no italics/bold
    return `Scenarist_SCC V1.0

00:00:01;00 9420 ${hex}`;
  }

  function sampleBurnIn() {
    return "No Preview Available";
  }

  // -------------------------------------------------------
  // FIX 3 — Hook the preview to output-format dropdown ONLY
  // -------------------------------------------------------
  ready(() => {
    const fmtHidden = document.getElementById("transcribe-output-formats");
    const preview = document.getElementById("sample-preview");

    if (!fmtHidden || !preview) return;

    function updatePreview() {
      const fmt = fmtHidden.value;

      let out = "";
      switch (fmt) {
        case "txt":       out = sampleTXT(); break;
        case "srt":       out = sampleSRT(); break;
        case "vtt":       out = sampleVTT(); break;
        case "xml":       out = sampleXML(); break;
        case "script":    out = sampleSCRIPT(); break;
        case "finalJson": out = sampleJSON(); break;
        case "scc":       out = sampleSCC(); break;
        case "burnIn":    out = sampleBurnIn(); break;
        default:
          out = "Welcome to Lead AE. I am here to Assist.";
      }

      preview.textContent = out;
    }

    // Update whenever the output-format dropdown changes
    ["change", "input", "dropdown:change"].forEach(ev => {
      fmtHidden.addEventListener(ev, updatePreview);
    });

    // Initial preview load
    updatePreview();
  });

})();
