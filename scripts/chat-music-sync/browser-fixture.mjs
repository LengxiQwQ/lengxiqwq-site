// Bundles an isolated test page in memory. Does not start Astro or connect to a room.
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = `<script>
import MusicPanel from './src/components/pages/chat/MusicPanel.svelte';
let musicState = $state(null);
const audio = document.createElement('audio');
audio.preload = 'auto'; audio.muted = true; document.body.append(audio);
const reports = [];
const now = () => performance.timeOrigin + performance.now();
window.musicFixture = {
 audio, reports, now,
 setTrack(play) { musicState = {current:play,queue:[],serverTime:now(),requesterOnline:true,voteCount:0,voteThreshold:1}; },
};
</script>
<MusicPanel audioEl={audio} musicState={musicState} roomId="fixture" currentUser={null}
 onlineMemberCount={1} clockOffsetMs={0} serverNow={now}
 onSearchOnline={async()=>({tracks:[],hasMore:false,page:1})} onEnqueueTrack={async()=>false}
 onRemoveQueue={()=>{}} onPlayQueued={()=>{}} onSkipTrack={()=>{}} onVoteSkip={()=>{}}
 onReady={(...args)=>reports.push(['ready',...args])}
 onReportDuration={(...args)=>reports.push(['duration',...args])}
 onTrackEnded={(...args)=>reports.push(['ended',...args])}
 onReportError={(...args)=>reports.push(['error',...args])}
 onPlaybackStatusChange={(s)=>window.musicFixture.status=s}/>`;
const result = await build({
  stdin: { contents: `import {mount} from 'svelte'; import Fixture from 'fixture.svelte'; mount(Fixture,{target:document.body});`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['browser'],
  plugins: [{ name: 'fixture-svelte', setup(builder) {
    builder.onResolve({filter:/^fixture\.svelte$/}, () => ({path:path.resolve('fixture.svelte'),namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'}, () => ({contents:compile(fixture,{filename:path.resolve('fixture.svelte'),generate:'client',css:'injected'}).js.code,resolveDir:process.cwd()}));
    builder.onResolve({filter:/^@\//}, args => ({path:path.resolve('src',args.path.slice(2))}));
    builder.onLoad({filter:/\.svelte$/}, async args => ({contents:compile(await readFile(args.path,'utf8'),{filename:args.path,generate:'client',css:'injected'}).js.code,resolveDir:path.dirname(args.path)}));
  }}], logLevel: 'silent'
});
process.stdout.write(JSON.stringify(result.outputFiles[0].text));
