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

let currentFfmpeg = null;
let activeStationUrl = '';
let activeStationName = '';
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

  // Check if station changed or first start
  if (data.current_station_url !== activeStationUrl || data.current_station_name !== activeStationName) {
    console.log(`\n[SIGNAL SURF] Active Station Changed: "${data.current_station_name}"`);
    console.log(`[URL] ${data.current_station_url}`);
    
    activeStationUrl = data.current_station_url;
    activeStationName = data.current_station_name;

    // Write station info to local text file (FFmpeg drawtext reads this live)
    fs.writeFileSync('song_title.txt', `WAVEFRONT INTERCEPT LOG // CURRENT SIGNAL: ${activeStationName.toUpperCase()}`);

    // Restart FFmpeg stream with new station URL
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

  if (!activeStationUrl) {
    console.log('No active station URL defined. Awaiting input...');
    return;
  }

  console.log('Initializing FFmpeg encoder pipeline...');
  
  // FFmpeg dynamic visualizer: Bouncing oscilloscope showwaves filter complex in Wavefront Teal (#0A7C6E)
  // Maps visual waves to the live audio stream, overlays standard monospace terminal font and streams to RTMP.
  // Chained filter complex: audio is visualised to waves, and then drawtext is overlaid on the wave video stream.
  const filterGraph = '[0:a]showwaves=s=1280x720:mode=line:colors=0x0A7C6E[waves];[waves]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf:textfile=song_title.txt:reload=1:fontcolor=0x0A7C6E:fontsize=24:box=1:boxcolor=0x000000BC:boxborderw=10:x=(w-text_w)/2:y=h-80[v]';

  const args = [
    '-re', // Read input in real time
    '-i', activeStationUrl, // Input live radio audio stream
    '-filter_complex', filterGraph,
    '-map', '[v]',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '1500k',
    '-maxrate', '1500k',
    '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
  ];

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
    if (code !== 0 && activeStationUrl) {
      console.log('Re-establishing connection pipeline in 5 seconds...');
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

// 2. Start polling Supabase database table every 30 seconds as a fail-safe fallback
checkInterval = setInterval(checkStreamConfig, 30000);
checkStreamConfig();

console.log('-------------------------------------------');
console.log('🛰️  Wavefront Autonomous Broadcast Node Active');
console.log('-------------------------------------------');
