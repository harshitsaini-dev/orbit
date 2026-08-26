import io

p = 'apps/web/src/routes/MyDrive.tsx'
s = io.open(p, encoding='utf-8').read()

# 1. Smaller batches, for headroom against the proxy's request ceiling.
old = """const DELETE_BATCH = 100;"""
new = """const DELETE_BATCH = 50;"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """ * Below that cap for a second reason: the server deletes them one at a time at
 * the provider, so a batch is a run of round trips held open by one request. A
 * hundred is a few seconds of work - large enough that a big selection is not
 * hundreds of requests, small enough that no single one sits near a proxy
 * timeout.
 */"""
new = """ * Well below that cap, and the reason is a hard limit rather than a taste.
 * The API is behind a proxy that closes a request after a hundred seconds, and
 * a batch is a run of provider calls held open by one request. Fifty at six at
 * a time is a few seconds - far enough from the ceiling that a slow provider,
 * or a rate limit being waited out, still lands comfortably inside it.
 *
 * Small batches also mean the progress bar actually moves, which is the
 * difference between a long delete and an apparently frozen one.
 */"""
assert s.count(old) == 1
s = s.replace(old, new)

# 2. Close the dialog as soon as the work starts; progress belongs on the list.
old = """  async function remove(files: OrbitFile[]) {
    setBusyId('delete');
    setDeleteProgress(files.length > DELETE_BATCH ? { done: 0, total: files.length } : null);"""
new = """  async function remove(files: OrbitFile[]) {
    setBusyId('delete');
    /*
     * The dialog goes now rather than at the end. Its warning has been read
     * and agreed to; keeping it up for the minutes a large delete takes only
     * hides the list it is talking about. Progress moves to a bar above the
     * selection, where the count it is counting can be seen.
     */
    setDialog(null);
    setDeleteProgress({ done: 0, total: files.length });"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """        failures.push(...result.failed);
        done += batch.length;
        if (ids.length > DELETE_BATCH) setDeleteProgress({ done, total: ids.length });"""
new = """        failures.push(...result.failed);
        done += batch.length;
        setDeleteProgress({ done, total: ids.length });"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """      setDialog(null);
      await forgetFolder(accountId, path);
      await load();
    } catch (err) {"""
new = """      await forgetFolder(accountId, path);
      await load();
    } catch (err) {"""
assert s.count(old) == 1
s = s.replace(old, new)

# 3. The bar itself, immediately above the select-all row.
old = """      <section className="clay" style={{ padding: 'clamp(0.75rem, 2vw, 1.25rem)' }}>
        {/*
          * What describes a list belongs on the list.
          *
          * Select-all, the sort and the view toggle were two rows of chrome
          * above the search box, describing rows the reader could not see yet.
          * Bin has always kept its select-all here; now they agree.
          */}
        {visible.length > 0 && ("""
new = """      <section className="clay" style={{ padding: 'clamp(0.75rem, 2vw, 1.25rem)' }}>
        {/*
          * Above the selection it is describing.
          *
          * A large delete is minutes of work at the provider, and a count that
          * only exists inside a modal is a count nobody can see next to the
          * list it is emptying. `aria-live` is polite rather than assertive:
          * this should be announced, not interrupt with every batch.
          */}
        {deleteProgress && (
          <div className="delete-progress" role="status" aria-live="polite">
            <div className="delete-progress__label">
              <span>
                Deleting {deleteProgress.done.toLocaleString()} of{' '}
                {deleteProgress.total.toLocaleString()}
              </span>
              <span>{Math.round((deleteProgress.done / deleteProgress.total) * 100)}%</span>
            </div>
            <div
              className="delete-progress__track"
              role="progressbar"
              aria-valuenow={deleteProgress.done}
              aria-valuemin={0}
              aria-valuemax={deleteProgress.total}
            >
              <div
                className="delete-progress__fill"
                style={{ width: `${(deleteProgress.done / deleteProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/*
          * What describes a list belongs on the list.
          *
          * Select-all, the sort and the view toggle were two rows of chrome
          * above the search box, describing rows the reader could not see yet.
          * Bin has always kept its select-all here; now they agree.
          */}
        {visible.length > 0 && ("""
assert s.count(old) == 1
s = s.replace(old, new)

# 4. The dialog no longer carries progress, since it is gone by then.
old = """          description={
            /*
             * Progress replaces the warning once it has started, because by
             * then the warning has been read and the only useful thing to say
             * is how far along it is. A large selection is deleted one file at
             * a time at the provider and takes minutes; without a number on
             * screen that is indistinguishable from a hang.
             */
            deleteProgress
              ? `Deleting ${deleteProgress.done.toLocaleString()} of ${deleteProgress.total.toLocaleString()}… this runs one file at a time at the provider, so a large selection takes a while. Leaving this page stops it.`
              : (capabilities?.trash
                  ? "They move to the provider's own bin, where they can still be recovered. Orbit's Bin page lists them."
                  : 'This provider keeps no bin. They are gone the moment you confirm, and nobody — including the provider — can bring them back.') +
                (dialog.files.length > DELETE_BATCH
                  ? ` ${dialog.files.length.toLocaleString()} files go in batches of ${DELETE_BATCH}, so this will take a few minutes.`
                  : '')
          }"""
new = """          description={
            (capabilities?.trash
              ? "They move to the provider's own bin, where they can still be recovered. Orbit's Bin page lists them."
              : 'This provider keeps no bin. They are gone the moment you confirm, and nobody — including the provider — can bring them back.') +
            (dialog.files.length > DELETE_BATCH
              ? ` This many runs in batches and takes a while; a bar above the list shows how far it has got. Leaving the page stops it.`
              : '')
          }"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
