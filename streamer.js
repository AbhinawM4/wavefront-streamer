const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL || 'https://kbbvgdmktwumuiqibpgf.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_pc0U_EEZ3v1UadQkoAIx6w_SJtxz3o4';
const streamKey = process.env.YOUTUBE_STREAM_KEY;

if (!streamKey) {
  console.error('CRITICAL: YOUTUBE_STREAM_KEY is not defined in environment.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

process.on('uncaughtException', async (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  try {
    await supabase.from('stream_config').update({ current_station_name: 'CRASH: ' + err.message }).eq('id', 1);
  } catch(e) {}
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  try {
    await supabase.from('stream_config').update({ current_station_name: 'REJECT: ' + reason }).eq('id', 1);
  } catch(e) {}
  process.exit(1);
});


let currentFfmpeg = null;
let activePlaylist = '';
let activeBackground = '';
let checkInterval = null;
let realtimeChannel = null;

function handleConfigChange(data) {
  if (!data) return;

  if (data.status !== 'streaming') {
    console.log('Stream status set to OFFLINE. Initiating graceful shutdown.');
    stopFfmpeg();
    cleanupAndExit();
    return;
  }

  // Check if configuration changed or first start
  if (data.active_playlist !== activePlaylist || data.active_background !== activeBackground) {
    console.log(`\n[CONTENT UPDATE] Active Playlist: "${data.active_playlist}" | Background: "${data.active_background}"`);
    
    activePlaylist = data.active_playlist;
    activeBackground = data.active_background;

    // Write title log
    fs.writeFileSync('song_title.txt', `WAVEFRONT INTERCEPT LOG // CURRENT PLAYLIST: ${activePlaylist.toUpperCase()}`);

    // Restart FFmpeg stream with new content
    startFfmpeg();
  }
}

async function checkStreamConfig() {
  try {
    const { data, error } = await supabase
      .from('stream_config')
      .select('*')
      .eq('id', 1)
      .single();

    if (error) {
      console.error('Error fetching stream config:', error.message);
      return;
    }

    handleConfigChange(data);
  } catch (err) {
    console.error('Error in config check loop:', err);
  }
}

function startFfmpeg() {
  stopFfmpeg();

  if (!activePlaylist) {
    console.log('No active playlist defined. Awaiting input...');
    return;
  }

  console.log('Generating dynamic playlist.txt for FFmpeg...');
  const playlistDir = `playlists/${activePlaylist}`;
  if (!fs.existsSync(playlistDir)) {
    console.error(`Playlist directory not found: ${playlistDir}`);
    return;
  }

  const files = fs.readdirSync(playlistDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
  if (files.length === 0) {
    console.error(`No audio files found in: ${playlistDir}`);
    return;
  }

  const playlistContent = files.map(f => `file '${playlistDir}/${f}'`).join('\n');
  fs.writeFileSync('playlist.txt', playlistContent);
  console.log(`Playlist generated with ${files.length} tracks.`);

  console.log('Initializing FFmpeg encoder pipeline...');
  
  let args = [];
  const backgroundFile = activeBackground || 'loop.mp4';
  const hasLoopVideo = fs.existsSync(backgroundFile);

  if (hasLoopVideo) {
    console.log(`Detected custom loop video background (${backgroundFile}). Overlaying info...`);
    
    const filterGraph = '[1:v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf:textfile=song_title.txt:reload=1:fontcolor=0x0A7C6E:fontsize=16:box=1:boxcolor=0x000000BC:boxborderw=10:x=(w-text_w)/2:y=h-80[v]';

    args = [
      '-re',                   
      '-f', 'concat',          // Force concat format
      '-safe', '0',            // Allow unsafe file paths in concat
      '-stream_loop', '-1',    // Loop the audio playlist infinitely
      '-i', 'playlist.txt',    // [Input 0] Generated text file of audio tracks
      '-stream_loop', '-1',    // Loop the MP4 video infinitely
      '-i', backgroundFile,    // [Input 1] Looping background MP4 video
      '-filter_complex', filterGraph,
      '-map', '[v]',           
      '-map', '0:a',           
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '4000k',
      '-maxrate', '4000k',
      '-bufsize', '8000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ];
  } else {
    console.log(`No ${backgroundFile} found. Defaulting to classic black background oscilloscope...`);
    const filterGraph = '[0:a]showwaves=s=1280x720:mode=line:colors=0x0A7C6E[waves];[waves]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf:textfile=song_title.txt:reload=1:fontcolor=0x0A7C6E:fontsize=16:box=1:boxcolor=0x000000BC:boxborderw=10:x=(w-text_w)/2:y=h-80[v]';

    args = [
      '-re',                   
      '-f', 'concat',          
      '-safe', '0',            
      '-stream_loop', '-1',    
      '-i', 'playlist.txt',    
      '-filter_complex', filterGraph,
      '-map', '[v]',
      '-map', '0:a',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '4000k',
      '-maxrate', '4000k',
      '-bufsize', '8000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ];
  }

  console.log(`Piping stream to YouTube Live RTMP...`);
  const ffmpegProcess = spawn('ffmpeg', args);
  currentFfmpeg = ffmpegProcess;

  ffmpegProcess.stdout.on('data', (data) => {
    console.log(`[FFmpeg STDOUT] ${data}`);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    // FFmpeg logs stats to stderr
    const log = data.toString();
    if (log.includes('frame=') || log.includes('speed=')) {
      process.stdout.write(`\r${log.trim().slice(0, 100)}`);
    } else if (log.includes('Error') || log.includes('warning') || log.includes('failed')) {
      console.log(`\n[FFmpeg LOG] ${log.trim()}`);
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`\n[FFmpeg] Process closed with exit code ${code}`);
    
    // Only set currentFfmpeg to null if it's still pointing to the process that just closed
    if (currentFfmpeg === ffmpegProcess) {
      currentFfmpeg = null;
    }
    
    if (ffmpegProcess.isIntentional) {
      console.log('Intentional shutdown completed. Resetting state.');
      return;
    }
    
    // If it crashed unexpectedly but we are still in streaming status, auto-restart
    if (code !== 0 && activePlaylist) {
      console.log('Re-establishing connection pipeline in 5 seconds...');
      supabase.from('stream_config').update({ current_station_name: 'FFMPEG CRASH CODE: ' + code }).eq('id', 1).then();
      setTimeout(startFfmpeg, 5000);
    }
  });
}

function stopFfmpeg() {
  if (currentFfmpeg) {
    console.log('Terminating active FFmpeg process...');
    currentFfmpeg.isIntentional = true;
    try {
      currentFfmpeg.kill('SIGKILL');
    } catch (e) {}
    currentFfmpeg = null;
  }
}

function cleanupAndExit() {
  console.log('Closing streamer process.');
  if (checkInterval) {
    clearInterval(checkInterval);
  }
  if (realtimeChannel) {
    console.log('Unsubscribing from Supabase Realtime channel...');
    realtimeChannel.unsubscribe();
  }
  process.exit(0);
}

// 1. Subscribe to Supabase Realtime changes for INSTANT signal surfing
realtimeChannel = supabase
  .channel('public:stream_config')
  .on(
    'postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'stream_config', filter: 'id=eq.1' },
    (payload) => {
      console.log('\n⚡ [REALTIME UPLINK] Station update received instantly!');
      handleConfigChange(payload.new);
    }
  )
  .subscribe((status) => {
    console.log(`📡 [REALTIME] WebSocket connection status: ${status}`);
  });

// 2. Initial Boot Sequence
async function init() {
  console.log('Booting autonomous streamer. Syncing database state to LIVE...');
  try {
    await supabase
      .from('stream_config')
      .update({ status: 'streaming', updated_at: new Date().toISOString() })
      .eq('id', 1);
  } catch (e) {
    console.error('Failed to sync initial DB state:', e);
  }

  // Start polling Supabase database table every 30 seconds as a fail-safe fallback
  checkInterval = setInterval(checkStreamConfig, 30000);
  checkStreamConfig();
}

init();

// 3. Autonomous Shutdown Sequence (Exits cleanly after 5.5 hours to prevent exceeding limits)
const SHUTDOWN_TIMEOUT_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes
console.log(`⏰ [TIMER] Autonomous shutdown sequence scheduled in 5.5 hours (${5.5 * 60} minutes)`);
setTimeout(async () => {
  console.log('\n🚨 [AUTO-SHUTDOWN] 5.5 hours limit reached. Initiating clean termination...');
  try {
    const { error } = await supabase
      .from('stream_config')
      .update({
        status: 'offline',
        updated_at: new Date().toISOString()
      })
      .eq('id', 1);
    
    if (error) throw error;
    console.log('[AUTO-SHUTDOWN] Supabase status set to offline.');
  } catch (err) {
    console.error('[AUTO-SHUTDOWN] Failed to update DB state:', err.message || err);
  }
  
  stopFfmpeg();
  cleanupAndExit();
}, SHUTDOWN_TIMEOUT_MS);

console.log('-------------------------------------------');
console.log('🛰️  Wavefront Autonomous Broadcast Node Active');
console.log('-------------------------------------------');
