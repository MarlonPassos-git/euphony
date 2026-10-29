import { css, html, LitElement, nothing, PropertyValues, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  ContextCheckpoint,
  ContextReport,
  ContextSource
} from '../../utils/context-origins';
import componentCSS from './context-origins.css?inline';

const categories = {
  base: 'Base instructions',
  instructions: 'Developer instructions',
  agents: 'AGENTS.md',
  skills: 'Skill catalog',
  memory: 'Memory',
  environment: 'Environment & plugins',
  tools: 'Built-in tool definitions',
  mcp: 'MCP tool definitions',
  conversation: 'Conversation',
  calls: 'Tool calls',
  results: 'Tool results',
  summary: 'Compaction summary'
};
const format = (value: number | null): string =>
  value === null ? 'Not recorded' : value.toLocaleString('en-US');

@customElement('euphony-context-origins')
export class EuphonyContextOrigins extends LitElement {
  @property({ attribute: false }) events: unknown[] = [];
  @property() theme: 'auto' | 'light' | 'dark' = 'light';
  @state() private report: ContextReport | null = null;
  @state() private checkpoints: ContextCheckpoint[] = [];
  @state() private selectedRequest = 0;
  @state() private filter = '';
  @state() private expandedCategories = new Set<string>();
  @state() private excluded = new Set<string>();
  @state() private loading = false;
  @state() private error = '';
  @state() private copyStatus = '';
  private worker: Worker | null = null;
  private request = 0;

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has('events')) {
      this.selectedRequest = 0;
      this.excluded = new Set();
      this.analyze();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.worker?.terminate();
    this.worker = null;
  }

  private analyze() {
    this.loading = true;
    this.error = '';
    this.worker?.terminate();
    this.worker = new Worker(new URL('./context-worker.ts', import.meta.url), {
      type: 'module'
    });
    const request = ++this.request;
    this.worker.onmessage = (
      event: MessageEvent<{
        request: number;
        error?: string;
        report?: ContextReport;
        checkpoints?: ContextCheckpoint[];
      }>
    ) => {
      if (event.data.request !== this.request) return;
      this.loading = false;
      if (event.data.error) {
        this.error = event.data.error;
        return;
      }
      this.report = event.data.report ?? null;
      this.checkpoints = event.data.checkpoints ?? [];
      this.excluded = new Set();
    };
    this.worker.onerror = () => {
      this.loading = false;
      this.error =
        'Could not analyze this session. Retry or choose another file.';
    };
    this.worker.postMessage({
      events: this.events,
      index: this.selectedRequest,
      request
    });
  }

  private toggleSource(source: ContextSource) {
    const excluded = new Set(this.excluded);
    if (excluded.has(source.id)) excluded.delete(source.id);
    else excluded.add(source.id);
    this.excluded = excluded;
  }

  private async copyReport() {
    if (!this.report) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            ...this.report,
            estimator: 'o200k_base; text only',
            percentagesBasis:
              'Estimated recorded text, not exact provider usage',
            simulation: {
              excludedSources: [...this.excluded],
              estimatedRemaining: this.report.sources
                .filter(s => !this.excluded.has(s.id))
                .reduce((n, s) => n + s.tokens, 0),
              changesAgentConfiguration: false
            }
          },
          null,
          2
        )
      );
      this.copyStatus = 'Report copied. It contains the source text.';
    } catch {
      this.copyStatus =
        'Clipboard unavailable. Allow clipboard access and try again.';
    }
  }

  private renderSource(source: ContextSource, total: number) {
    const excluded = this.excluded.has(source.id);
    return html`
      <details class="source" ?data-excluded=${excluded}>
        <summary>
          <span class="source-name"
            >${source.title}<small
              >${source.stateOnly ? 'Snapshot only' : source.evidence}</small
            ></span
          >
          <span class="quantity"
            >${source.stateOnly
              ? 'Not measured'
              : `~${format(source.tokens)}`}<small
              >${total && !source.stateOnly
                ? `${((100 * source.tokens) / total).toFixed(1)}% of text estimate`
                : 'Not counted'}</small
            ></span
          >
        </summary>
        <div class="source-content">
          <dl>
            <dt>Origin</dt>
            <dd>${source.origin || 'Recorded session message'}</dd>
            <dt>Evidence</dt>
            <dd>
              ${source.evidence}${source.stateOnly
                ? ' · state does not prove request inclusion'
                : ' · recorded text'}
            </dd>
          </dl>
          <p class="source-advice">
            ${source.category === 'skills'
              ? 'This is catalog metadata. Its presence does not mean the full skill was read or invoked.'
              : source.category === 'base'
                ? 'Supplied by the agent. No user setting to remove this is established by the session file.'
                : 'Use the origin and text to identify its configuration source. The viewer cannot change your agent.'}
          </p>
          ${source.stateOnly
            ? nothing
            : html` <label class="simulation-control"
                ><input
                  type="checkbox"
                  .checked=${excluded}
                  @change=${() => {
                    this.toggleSource(source);
                  }}
                />
                Exclude from estimate (simulation only)</label
              >`}
          <pre tabindex="0" aria-label=${`${source.title} source text`}>
${source.text}</pre
          >
        </div>
      </details>
    `;
  }

  render() {
    const report = this.report;
    const total = report?.estimatedTokens ?? 0;
    const saved =
      report?.sources
        .filter(s => this.excluded.has(s.id))
        .reduce((n, s) => n + s.tokens, 0) ?? 0;
    const filter = this.filter.trim().toLowerCase();
    const matches = (s: ContextSource) =>
      !filter ||
      `${s.title} ${s.origin} ${s.text} ${categories[s.category]}`
        .toLowerCase()
        .includes(filter);
    return html`
      <section class="inspector" aria-labelledby="context-title">
        <header>
          <div>
            <h2 id="context-title">Where does this context come from?</h2>
            <p>
              Inspect the text recorded before a model response. Expand a source
              to see its origin.
            </p>
          </div>
          <button
            @click=${() => void this.copyReport()}
            ?disabled=${!report || this.loading}
          >
            Copy report JSON
          </button>
        </header>
        <div class="controls">
          <label
            >Request<select
              aria-label="Request"
              .value=${String(this.selectedRequest)}
              @change=${(e: Event) => {
                this.selectedRequest = Number(
                  (e.target as HTMLSelectElement).value
                );
                this.analyze();
              }}
              ?disabled=${this.loading || this.checkpoints.length < 2}
            >
              ${this.checkpoints.map(
                (c, i) =>
                  html`<option value=${i}>
                    ${c.label}${i === 0 ? ' · initial context' : ''} ·
                    ${format(c.input)} input tokens
                  </option>`
              )}
            </select></label
          >
          <label
            >Find a source<input
              type="search"
              placeholder="Skill, plugin, MCP, path or text…"
              .value=${this.filter}
              @input=${(e: Event) => {
                this.filter = (e.target as HTMLInputElement).value;
              }}
          /></label>
        </div>
        ${this.loading
          ? html`<p role="status">Analyzing recorded context…</p>`
          : nothing}
        ${this.error
          ? html`<p role="alert">
              ${this.error}
              <button
                @click=${() => {
                  this.analyze();
                }}
              >
                Retry
              </button>
            </p>`
          : nothing}
        ${report && !this.loading && !this.error
          ? html`
              <dl class="usage">
                <div>
                  <dt>Input · recorded by Codex</dt>
                  <dd>${format(report.checkpoint.input)}</dd>
                </div>
                <div>
                  <dt>Output · recorded by Codex</dt>
                  <dd>${format(report.checkpoint.output)}</dd>
                </div>
                <div>
                  <dt>Observable text · estimated</dt>
                  <dd>~${format(total)}</dd>
                </div>
              </dl>
              <p class="basis">
                Percentages below divide the <strong>text estimate</strong>, not
                the context-window capacity or the recorded input. Tokenizer:
                o200k_base. These totals may differ.
              </p>
              <div class="simulation" role="status">
                ${saved
                  ? html`Simulation: ~${format(total - saved)} text tokens
                      remain; ~${format(saved)} excluded.
                      <button
                        @click=${() => {
                          this.excluded = new Set();
                        }}
                      >
                        Reset simulation
                      </button>`
                  : 'Expand a source to simulate exclusion. Your Codex settings and session stay unchanged.'}
              </div>
              <div
                class="table-scroll"
                role="region"
                aria-label="Context categories"
                tabindex="0"
              >
                <table>
                  <caption>
                    Composition of recorded text
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Source category</th>
                      <th scope="col">Est. tokens</th>
                      <th scope="col">Share of estimate</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${Object.entries(categories).map(([key, label]) => {
                      const items = report.sources
                        .filter(s => s.category === key && matches(s))
                        .sort((a, b) => b.tokens - a.tokens);
                      if (!items.length && filter) return nothing;
                      const tokens = report.sources
                        .filter(s => s.category === key)
                        .reduce((n, s) => n + s.tokens, 0);
                      const percent = total ? (100 * tokens) / total : 0;
                      const observed = report.sources.some(
                        s => s.category === key && !s.stateOnly
                      );
                      const expanded =
                        !!filter || this.expandedCategories.has(key);
                      return html`
                        <tr>
                          <th scope="row">
                            <button
                              class="category-toggle"
                              aria-expanded=${expanded}
                              aria-controls=${`category-${key}`}
                              @click=${() => {
                                const next = new Set(this.expandedCategories);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                this.expandedCategories = next;
                              }}
                            >
                              <svg
                                viewBox="0 0 16 16"
                                width="14"
                                height="14"
                                aria-hidden="true"
                              >
                                <path
                                  d="m6 3 5 5-5 5"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="1.5"
                                /></svg
                              >${label}
                            </button>
                          </th>
                          <td>
                            ${observed ? `~${format(tokens)}` : 'Not measured'}
                          </td>
                          <td>
                            ${observed
                              ? html`<span class="share-bar" aria-hidden="true"
                                    ><span
                                      style=${`width:${percent}%`}
                                    ></span></span
                                  >${percent.toFixed(1)}%`
                              : 'Not observed'}
                          </td>
                        </tr>
                        ${items.length
                          ? html`<tr
                              class="source-row"
                              id=${`category-${key}`}
                              ?hidden=${!expanded}
                            >
                              <td colspan="3">
                                ${items.map(s => this.renderSource(s, total))}
                              </td>
                            </tr>`
                          : html` <tr
                              class="source-row"
                              id=${`category-${key}`}
                              ?hidden=${!expanded}
                            >
                              <td colspan="3">
                                <p class="not-recorded">
                                  No attributable text observed in this
                                  category. This does not prove it was absent
                                  from the request.
                                </p>
                              </td>
                            </tr>`}
                      `;
                    })}
                  </tbody>
                </table>
              </div>
              ${filter && !report.sources.some(matches)
                ? html`<p role="status">
                    No sources match “${this.filter}”. Try a name, path or
                    phrase from the source text.
                  </p>`
                : nothing}
              <details class="method">
                <summary>What this report can and cannot establish</summary>
                <ul>
                  ${report.notices.map(notice => html`<li>${notice}</li>`)}
                </ul>
                <p>
                  No file or configuration is modified. Exclusions are
                  hypothetical text estimates, not guaranteed token savings.
                  Installed, advertised, loaded and invoked are different
                  states.
                </p>
              </details>
            `
          : nothing}
        <p class="copy-status" role="status">${this.copyStatus}</p>
      </section>
    `;
  }

  static styles = [
    css`
      ${unsafeCSS(componentCSS)}
    `
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'euphony-context-origins': EuphonyContextOrigins;
  }
}
