import { launchBrowser, openContext, loadPage, closeBrowser } from './capture.ts';
import { decideNextAction, carryOut, settle, watchNavigations, describeAction, type HistoryEntry } from './agent.ts';
import { startRecording } from './recording.ts';
const browser = await launchBrowser({});
const { context } = await openContext(browser, 'desktop', {});
const page = await context.newPage();
const navigations = watchNavigations(page);
await loadPage(page, 'https://resend.com', { waitForBanner: true });
const recording = await startRecording(page, 'desktop');
const history: HistoryEntry[] = [];
const flow = { goal: 'Open the Blog from the footer and read the latest post', success: 'A blog post is shown' };
for (let step = 1; step <= 6; step++) {
  const action = await decideNextAction(flow, page, history);
  console.log(step, describeAction(action), action.thought);
  if (action.action === 'done' || action.action === 'give_up') break;
  const urlBefore = page.url();
  await carryOut(page, action, recording);
  await settle(page, navigations);
  history.push({ action: describeAction(action), result: page.url() !== urlBefore ? `now at ${new URL(page.url()).pathname}` : 'the page changed' });
}
await page.screencast.stop();
await context.close(); await closeBrowser(browser);
