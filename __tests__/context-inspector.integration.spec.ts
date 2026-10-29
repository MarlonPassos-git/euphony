import { expect, test, type Page } from '@playwright/test';

// Synthetic prompt evidence only. Private Codex transcripts never belong in
// fixtures or browser traces committed to the repository.
const event = (type: string, payload: unknown) => ({ type, payload });
const message = (role: string, text: string) =>
  event('response_item', {
    type: 'message',
    role,
    content: [{ type: 'input_text', text }]
  });
const original =
  '<INSTRUCTIONS>\n# Project rules\n\nUse **focused functions**.\n\n![remote](https://example.invalid/private.png)\n<script>window.injectionExecuted = true</script>\n</INSTRUCTIONS>';
const fixture = [
  event('session_meta', {
    id: 'synthetic-context',
    base_instructions: { text: 'Base instructions' }
  }),
  message('user', `# AGENTS.md instructions for /project\n${original}`),
  message(
    'developer',
    '<skills_instructions>\n### Available skills\n- sample: Example skill. (file: /skills/sample/SKILL.md)\n</skills_instructions>'
  ),
  message('user', 'oi'),
  message('assistant', 'Hello'),
  event('token_usage_record', {
    usage: { input_tokens: 100, output_tokens: 3 }
  })
];

async function loadInspector(page: Page) {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(fixture.map(item => JSON.stringify(item)).join('\n'))
  });
  const trigger = page.getByRole('button', {
    name: 'Context origins',
    exact: true
  });
  await trigger.click();
  const panel = page.getByRole('dialog', {
    name: 'Context origins',
    exact: true
  });
  await expect(panel.locator('.usage')).toContainText('100');
  return { trigger, panel };
}

test('uses a toolbar inspector, renders safe Markdown, and preserves original text and simulation', async ({
  page
}) => {
  const remoteRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('example.invalid'))
      remoteRequests.push(request.url());
  });
  const { trigger, panel } = await loadInspector(page);
  await panel.getByRole('button', { name: /^Project instructions/ }).click();
  await expect(
    panel.getByRole('heading', { name: 'Project rules', exact: true })
  ).toBeVisible();
  await expect(panel.locator('.preview strong')).toHaveText(
    'focused functions'
  );
  await expect(
    panel.locator('.preview img, .preview script, .preview iframe')
  ).toHaveCount(0);
  expect(remoteRequests).toEqual([]);
  await panel.getByRole('button', { name: 'Original', exact: true }).click();
  await expect(panel.locator('.preview pre')).toHaveText(original);
  await panel
    .getByRole('checkbox', { name: 'Exclude from estimate (simulation only)' })
    .check();
  await expect(panel.locator('.simulation')).toContainText('excluded');
  await panel
    .getByRole('button', { name: 'Close context origins', exact: true })
    .click();
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel.locator('.preview pre')).toHaveText(original);
  await expect(panel.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('navigates between source list and detail on mobile without horizontal overflow', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel } = await loadInspector(page);
  await panel.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(
    panel.getByRole('heading', { name: 'Context composition', exact: true })
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Skill catalog', exact: true })
    .click();
  await expect(panel.getByRole('button', { name: /^sample/ })).toBeVisible();
  await panel.getByLabel('Find a source').fill('sample');
  await panel.getByRole('button', { name: /^sample/ }).click();
  await expect(
    panel.getByRole('heading', { name: 'sample', exact: true })
  ).toBeVisible();
  await expect(
    panel.getByRole('complementary', { name: 'Source browser' })
  ).not.toBeVisible();
  await panel
    .getByRole('button', { name: 'Back to sources', exact: true })
    .click();
  await expect(panel.getByRole('button', { name: /^sample/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^sample/ })).toBeFocused();
  expect(await panel.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(
    false
  );
});

test('retains a usable nonmodal dialog when the Popover API is unavailable', async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value: undefined
    });
  });
  const { panel, trigger } = await loadInspector(page);
  await panel
    .getByRole('button', { name: 'Close context origins', exact: true })
    .click();
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('keeps the conversation stationary while opening and exploring the inspector', async ({
  page
}) => {
  const { panel, trigger } = await loadInspector(page);
  await panel
    .getByRole('button', { name: 'Close context origins', exact: true })
    .click();
  const conversation = page.locator('euphony-conversation').last();
  const before = await conversation.boundingBox();
  await page.evaluate(() => {
    const evidence: { value: number; recentInput: boolean }[] = [];
    Object.assign(window, { contextLayoutShifts: evidence });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        evidence.push({
          value: shift.value,
          recentInput: shift.hadRecentInput
        });
      }
    }).observe({ type: 'layout-shift', buffered: false });
  });
  await trigger.click();
  await panel.getByRole('button', { name: /^Project instructions/ }).click();
  await panel.getByRole('button', { name: 'Original', exact: true }).click();
  await panel.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  );
  expect(await conversation.boundingBox()).toEqual(before);
  const evidence = await page.evaluate(
    () =>
      (
        window as unknown as {
          contextLayoutShifts: { value: number; recentInput: boolean }[];
        }
      ).contextLayoutShifts
  );
  const cls = evidence
    .filter(shift => !shift.recentInput)
    .reduce((sum, shift) => sum + shift.value, 0);
  expect(cls).toBeLessThan(0.01);
  console.log(
    JSON.stringify({
      scope: 'context-inspector-interactions',
      cls,
      allShiftSum: evidence.reduce((sum, shift) => sum + shift.value, 0)
    })
  );
});
