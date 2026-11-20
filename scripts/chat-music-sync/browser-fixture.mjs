// Bundles an isolated test page in memory. Does not start Astro or connect to a room.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { compile } from "svelte/compiler";

const fixture = `<script>
import MusicPanel from './src/components/pages/chat/MusicPanel.svelte';
import { MusicClock } from './src/components/pages/chat/musicClock';
import { recordMusicEvent } from './src/components/pages/chat/musicTrace';
const clock = new MusicClock();
let musicState = $state(null);
const audio = document.createElement('audio');
audio.preload = 'auto'; audio.muted = true; document.body.append(audio);
const reports = [];
const now = () => window.roomPreview ? clock.now() : performance.timeOrigin + performance.now();
window.musicFixture = {
 audio, reports, now, clock,
 receive(state) {
  if (!musicState || musicState.current?.uid !== state.current?.uid) {
   recordMusicEvent("broadcast", state.current?.uid, { serverSent: state.serverTime, selectionStartedAt: state.current?.selectionStartedAt ?? 0, deadline: state.current?.startedAt ?? 0, clock: now() });
  }
  clock.seed(state.serverTime); musicState = state;
 },
 setTrack(play, next = null) { musicState = {current:play,next,queue:[],serverTime:now(),requesterOnline:true,voteCount:0,voteThreshold:1}; },
};
</script>
<MusicPanel audioEl={audio} musicState={musicState} roomId="fixture" currentUser={null}
 onlineMemberCount={1} clockOffsetMs={0} serverNow={now}
 onSearchOnline={async()=>({tracks:[],hasMore:false,page:1})} onEnqueueTrack={async()=>false}
 onRemoveQueue={()=>{}} onPlayQueued={()=>{}} onSkipTrack={()=>window.roomPreview?.skip(musicState?.current?.uid)} onVoteSkip={()=>window.roomPreview?.skip(musicState?.current?.uid)}
 onReady={(...args)=>reports.push(['ready',...args])}
 onReportDuration={(...args)=>reports.push(['duration',...args])}
 onTrackEnded={(...args)=>reports.push(['ended',...args])}
 onReportError={(...args)=>reports.push(['error',...args])}
 onPlaybackStatusChange={(s)=>window.musicFixture.status=s}/>`;
const baselinePlayer = process.env.ROOM_AUDIO_BASELINE;
const result = await build({
	stdin: {
		contents: `import {mount} from 'svelte'; import Fixture from 'fixture.svelte'; mount(Fixture,{target:document.body});`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	conditions: ["browser"],
	plugins: [
		{
			name: "fixture-svelte",
			setup(builder) {
				if (baselinePlayer) {
					builder.onLoad({ filter: /roomAudioPlayer\.ts$/ }, async (args) => ({
						contents: await readFile(baselinePlayer, "utf8"),
						loader: "ts",
						resolveDir: path.dirname(args.path),
					}));
				}
				builder.onResolve({ filter: /^fixture\.svelte$/ }, () => ({
					path: path.resolve("fixture.svelte"),
					namespace: "fixture",
				}));
				builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
					contents: compile(fixture, {
						filename: path.resolve("fixture.svelte"),
						generate: "client",
						css: "injected",
					}).js.code,
					resolveDir: process.cwd(),
				}));
				builder.onResolve({ filter: /^@\// }, (args) => ({
					path: path.resolve("src", args.path.slice(2)),
				}));
				builder.onLoad({ filter: /\.svelte$/ }, async (args) => ({
					contents: compile(await readFile(args.path, "utf8"), {
						filename: args.path,
						generate: "client",
						css: "injected",
					}).js.code,
					resolveDir: path.dirname(args.path),
				}));
			},
		},
	],
	logLevel: "silent",
});
process.stdout.write(JSON.stringify(result.outputFiles[0].text));
