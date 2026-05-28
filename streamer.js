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

    if (!data) {
      console.error('No stream config row found.');
      return;
    }

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
  const args = [
    '-re', // Read input in real time
    '-i', activeStationUrl, // Input live radio audio stream
    '-filter_complex', '[0:a]showwaves=s=1280x720:mode=line:colors=0x0A7C6E[v]',
    '-map', '[v]',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '1500k',
    '-maxrate', '1500k',
    '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-vf', 'drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf:textfile=song_title.txt:reload=1:fontcolor=0x0A7C6E:fontsize=24:box=1:boxcolor=0x000000BC:boxborderw=10:x=(w-text_w)/2:y=h-80',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
  ];

  console.log(`Piping stream to YouTube Live RTMP...`);
  currentFfmpeg = spawn('ffmpeg', args);

  currentFfmpeg.stdout.on('data', (data) => {
    console.log(`[FFmpeg STDOUT] ${data}`);
  });

  currentFfmpeg.stderr.on('data', (data) => {
    // FFmpeg logs stats to stderr
    const log = data.toString();
    if (log.includes('frame=') || log.includes('speed=')) {
      process.stdout.write(`\r${log.trim().slice(0, 100)}`);
    } else if (log.includes('Error') || log.includes('warning') || log.includes('failed')) {
      console.log(`\n[FFmpeg LOG] ${log.trim()}`);
    }
  });

  currentFfmpeg.on('close', (code) => {
    console.log(`\n[FFmpeg] Process closed with exit code ${code}`);
    currentFfmpeg = null;
    
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
  process.exit(0);
}

// Start polling Supabase database table every 10 seconds
checkInterval = setInterval(checkStreamConfig, 10000);
checkStreamConfig();

console.log('-------------------------------------------');
console.log('🛰️  Wavefront Autonomous Broadcast Node Active');
console.log('-------------------------------------------');
