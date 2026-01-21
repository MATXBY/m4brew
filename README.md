# M4Brew

M4Brew is a simple tool for converting and organising audiobooks into clean, chapterised **M4B** files with **AAC audio**, making them easier to manage and more reliable for media players like **Plex**, **Jellyfin**, **Audiobookshelf**, and similar tools.

It’s designed to remove the fiddly parts of audiobook housekeeping while staying **safe, predictable, and transparent**.

---

## Who it’s for

M4Brew is for anyone with audiobook folders full of MP3s or M4As who wants clean, reliable M4B files — without manual FFmpeg work.

---

## What M4Brew does

M4Brew batch converts your audiobooks into single `.m4b` files using **FFmpeg**, preserving audio quality while producing files that are:

- Easier for media managers to recognise  
- Simpler to tag and match with metadata  
- Cleaner to store and back up  

Each source file becomes a **chapter** in the final M4B, so chapter navigation remains intact.

---

## How it works

1. Select your audiobook folder  
2. Choose your audio settings (channels and bitrate)  
3. Run a **Test** to see what would happen  
4. Run the conversion when you’re happy  

Then grab a brew ☕ — everything runs in the background.

---

## Folder structure (important)

M4Brew expects your audiobooks to be organised like this:
```text
Audiobooks/
└── Author Name/
    └── Book Title/
        └── audio files
```

This structure is essential. It allows M4Brew to:

- Name output files consistently  
- Generate reliable chapter titles  
- Help media managers correctly identify books and authors  

---

## Supported input formats

- MP3 (single or multiple files)  
- M4A (single or multiple files)  
- Existing M4B (merged into one)  

Output is always a single, chapterised **.m4b (AAC)** file.

---

## Test vs Run

Every task supports **Test** and **Run** modes.

**Test**  
Shows exactly what would happen — no files are modified.

**Run**  
Performs the actual conversion, renaming, or cleanup.

Nothing destructive happens unless you explicitly choose to run it.

---

## Safety first

M4Brew is intentionally cautious by design:

- Original audio files are never deleted automatically  
- Converted files are created alongside your existing structure  
- Cleanup is a separate, explicit step  
- Jobs can be safely cancelled — no half-written files are left behind  

---

## Under the hood

M4Brew uses **FFmpeg** for all audio processing — the same trusted, industry-standard tool used by professional media workflows.

The app simply wraps this power in a focused, friendly interface.

---

## Why M4Brew?

Audiobooks often come in messy formats that confuse media players.  
M4Brew exists to:

- Reduce friction  
- Improve metadata matching  
- Keep your library tidy  
- Let you spend less time fixing files and more time listening  
