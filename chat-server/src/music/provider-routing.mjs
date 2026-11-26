const NEXT_PROVIDER_MS = 300;
const PRIORITY_WAIT_MS = 1600;

export function lookupPreferredProviders(providers, lookup, budgetMs, alternativeLimit = 3) {
  return new Promise(resolve => {
    const results = Array(providers.length).fill(null);
    const signals = providers.map(() => new AbortController());
    if (!providers.length) return resolve({ alternatives: [], temporaryFailure: false });
    let nextIndex = 0;
    let nextTimer;
    let releaseDownload;
    const downloadGate = new Promise(open => { releaseDownload = open; });
    const downloadTimer = setTimeout(releaseDownload, PRIORITY_WAIT_MS);
    let finished = false;
    let priorityTimer;
    const deadlineTimer = setTimeout(() => finish(true), budgetMs);

    function finish(timedOut = false) {
      if (finished) return;
      finished = true;
      clearTimeout(nextTimer);
      clearTimeout(downloadTimer);
      releaseDownload();
      clearTimeout(deadlineTimer);
      clearTimeout(priorityTimer);
      for (const signal of signals) signal.abort();
      const winner = results.find(result => result?.playable);
      if (winner) {
        resolve(winner);
        return;
      }
      const choices = new Map();
      for (const option of results.flatMap(result => result?.alternatives || [])) {
        if (!choices.has(option.track.id)) choices.set(option.track.id, option);
      }
      const order = ['same_artist_version', 'same_title', 'same_artist_other'];
      const alternatives = [...choices.values()]
        .sort((a, b) => order.indexOf(a.relation) - order.indexOf(b.relation)).slice(0, alternativeLimit);
      resolve({ alternatives, temporaryFailure: timedOut || results.some(result => result?.temporaryFailure),
        limited: results.some(result => result?.limited),
        failures: providers.flatMap((id, i) => {
          const result = results[i];
          if (result && !result.temporaryFailure && !result.limited) return [];
          const detail = String(result?.error || '');
          const status = detail.match(/HTTP\s+([45]\d\d)/i)?.[1];
          const reason = result?.limited ? '请求受限' : status ? '返回 HTTP ' + status
            : !result || /超时|timeout|timed out|budget exhausted/i.test(detail) ? '响应超时' : '未能完成音源检查';
          return [{ id, reason }];
        }) });
    }

    function startNext() {
      clearTimeout(nextTimer);
      if (finished || nextIndex >= providers.length) return;
      const index = nextIndex++;
      if (nextIndex < providers.length) nextTimer = setTimeout(startNext, NEXT_PROVIDER_MS);
      void start(index);
    }

    async function start(index) {
      try {
        results[index] = await lookup(providers[index], signals[index].signal, providers[index] === 'youtube' && index > 0 ? downloadGate : undefined);
      } catch {
        results[index] = { temporaryFailure: true };
      }
      if (finished) return;
      const youtubeIndex = providers.indexOf('youtube');
      if (youtubeIndex > 0 && results.slice(0, youtubeIndex).every(Boolean)) releaseDownload();
      const winner = results.findIndex(result => result?.playable);
      if (winner >= 0) {
        clearTimeout(nextTimer);
        for (let lower = winner + 1; lower < nextIndex; lower++) signals[lower].abort();
        if (results.slice(0, winner).every(Boolean)) finish();
        else priorityTimer ??= setTimeout(finish, PRIORITY_WAIT_MS);
      } else {
        startNext();
        if (results.every(Boolean)) finish();
      }
    }

    startNext();
  });
}
