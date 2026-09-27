KEN'S VOICE MESSAGE + THE BACKGROUND MUSIC
=========================================

Two mp3 files live in this folder. Replace either one and the page picks it up - you never
have to touch index.html, and you never have to rename anything:

1. ken-voice-message.mp3   <- the recording behind the "Play a VM from Ken" button
2. background-music.mp3    <- the soft song that starts when she taps the flower

HOW TO SWAP ONE IN
------------------
1. Put your own file in THIS folder and name it exactly like the file it replaces
   (overwrite the one that is here - keep the ".mp3" ending, do not edit index.html).
2. Any normal audio file usually works: a phone voice memo, WhatsApp export, m4a/aac/ogg
   renamed to .mp3, or an MP3 from anywhere. Keep the ".mp3" ending.
   If a renamed file refuses to play, convert it to a real mp3 first - the page will simply
   show "Ken's voice message isn't uploaded yet" (or stay quiet, for the music) instead of
   pretending.

WHAT HAPPENS AUTOMATICALLY
--------------------------
* The music never starts by itself: it waits for the tap that makes the flower bloom, so no
  browser autoplay rule is ever in the way (Android Chrome, iPhone Safari, Edge, desktop).
* The music loops forever and stays soft. window.BACKGROUND_MUSIC_VOLUME sits near the top
  of index.html: 0.25 by default, and 0.20-0.30 is the sweet spot.
* The song and the voice message are never heard at the same time. Pressing the VM button
  pauses the music at the exact second it had reached, and the music comes back at that same
  second when the message ends - it never restarts from the beginning. Pausing the VM by hand
  keeps the music paused, and the music only returns once the message has finished.
* A tiny "Music playing" note in the corner says what you are hearing (it reads "Music paused"
  while Ken talks). It hides itself when no music file can be loaded, and nothing else changes.

WHAT IS IN HERE RIGHT NOW
-------------------------
* ken-voice-message.mp3 - the recording in place at the moment; overwrite it with yours.
* background-music.mp3  - a generated 60 second silent placeholder (MPEG-1 Layer III, CBR
  64 kbps, 44.1 kHz, stereo, with a LAME-style "Info" frame so players know the length up
  front). Delete it once your own song is in place.

