# m4brew

m4brew is a simple tool for converting and organising audiobooks into clean, chapterised M4B files with AAC audio, making them easier to manage and more reliable for media players like Plex, Audiobookshelf, and similar tools.

It’s designed to remove the fiddly parts of audiobook housekeeping while staying safe, predictable, and transparent.

---

## What m4brew does

m4brew batch converts your audiobooks into single `.m4b` files using **FFmpeg**, preserving audio quality while producing files that are:

- Easier for media managers to recognise
- Simpler to tag and match with metadata
- Cleaner to store and back up

Each source file becomes a chapter in the final M4B, so chapter navigation remains intact.

---

## How it works

1. Select your audiobook folder  
2. Choose your audio settings (channels and bitrate)  
3. Run a **Test** to see what would happen  
4. Run the conversion when you’re happy  

Then grab a brew ☕ - everything runs in the background.

---

## Folder structure (important)

m4brew expects your audiobooks to be organised like this:
```text
Audiobooks/
└── Author Name/
    └── Book Title/
        └── audio files
```

This structure is essential. It allows m4brew to:

- Name output files consistently
- Generate reliable chapter titles
- Help media managers correctly identify books and authors

---

## Test vs Run

Every task supports **Test** and **Run** modes:

**Test**  
Shows exactly what would happen - no files are modified.

**Run**  
Performs the actual conversion, renaming, or cleanup.

Nothing destructive happens unless you explicitly choose to run it.

---

## Safety first

- Original audio files are never deleted automatically  
- Converted files are created alongside your existing structure  
- Cleanup is a separate, explicit step  
- No half-finished files if a job is cancelled  

m4brew is intentionally cautious by design.

---

## Under the hood

m4brew uses **FFmpeg** for all audio processing - the same trusted, industry-standard tool used by professional media workflows.

The app simply wraps this power in a focused, friendly interface.

---

## Why m4brew?

Audiobooks often come in messy formats that confuse media players.  
m4brew exists to:

- Reduce friction
- Improve metadata matching
- Keep your library tidy
- Let you spend less time fixing files and more time listening
