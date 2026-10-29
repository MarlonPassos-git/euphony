import { css, html, LitElement, nothing, PropertyValues, unsafeCSS } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { CONTEXT_CATEGORIES as categories } from '../../utils/context-types';
import type {
  ContextCheckpoint,
  ContextReport,
  ContextSource
} from '../../utils/context-types';
import { getMarkdownTemplate } from '../../utils/utils';
import iconCross from '../../images/icon-cross.svg?raw';
import componentCSS from './context-origins.css?inline';

const format = (n: number | null) =>
  n === null ? 'Not recorded' : n.toLocaleString('en-US');
const markdownTags = [
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'del',
  'blockquote',
  'pre',
  'code',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a'
];

@customElement('euphony-context-origins')
export class EuphonyContextOrigins extends LitElement {
  @property({ attribute: false }) events: unknown[] = [];
  @property() theme: 'auto' | 'light' | 'dark' = 'light';
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) invoker: HTMLElement | null = null;
  @query('dialog') private panel?: HTMLDialogElement;
  @state() private report: ContextReport | null = null;
  @state() private checkpoints: ContextCheckpoint[] = [];
  @state() private selectedRequest = 0;
  @state() private category = 'all';
  @state() private selectedSource: string | null = null;
  @state() private showOverview = false;
  @state() private mode: 'markdown' | 'original' = 'markdown';
  @state() private filter = '';
  @state() private excluded = new Set<string>();
  @state() private loading = false;
  @state() private error = '';
  @state() private copyStatus = '';
  private worker: Worker | null = null;
  private request = 0;

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has('events')) {
      this.selectedRequest = 0;
      this.selectedSource = null;
      this.excluded = new Set();
      this.analyze();
    }
  }

  updated(changed: PropertyValues<this>) {
    if (!changed.has('open') || !this.panel) return;
    // A nonmodal top-layer inspector leaves the conversation interactive.
    // Older browsers retain the same fixed panel through dialog.show().
    if (typeof this.panel.showPopover === 'function') {
      if (this.open && !this.panel.matches(':popover-open')) {
        // The optional source argument establishes keyboard navigation across
        // the toolbar/panel shadow roots; TS's DOM definitions predate it.
        const panel = this.panel as HTMLDialogElement & {
          showPopover(options?: { source?: HTMLElement }): void;
        };
        panel.showPopover({ source: this.invoker ?? undefined });
      } else if (!this.open && this.panel.matches(':popover-open'))
        this.panel.hidePopover();
    } else if (this.open && !this.panel.open) this.panel.show();
    else if (!this.open && this.panel.open) this.panel.close();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.worker?.terminate();
    this.worker = null;
  }

  private close() {
    if (
      typeof this.panel?.showPopover === 'function' &&
      this.panel.matches(':popover-open')
    )
      this.panel.hidePopover();
    else if (this.panel?.open) this.panel.close();
    // A lazily created, manually opened popover crossing shadow roots does
    // not consistently restore its slotted invoker in supported Chromium.
    // Preserve native restoration when it works; otherwise restore explicitly.
    if (this.invoker && !this.invoker.matches(':focus'))
      this.invoker.focus({ preventScroll: true });
    this.dispatchEvent(
      new CustomEvent('context-origins-closed', {
        bubbles: true,
        composed: true
      })
    );
  }

  private analyze() {
    this.loading = true;
    this.error = '';
    this.copyStatus = '';
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
      this.selectedSource = null;
    };
    this.worker.onerror = () => {
      this.loading = false;
      this.error = 'Analysis failed. Retry or choose another file.';
    };
    this.worker.postMessage({
      events: this.events,
      index: this.selectedRequest,
      request
    });
  }

  private toggleSource(source: ContextSource) {
    const next = new Set(this.excluded);
    if (next.has(source.id)) next.delete(source.id);
    else next.add(source.id);
    this.excluded = next;
  }

  private async copy(text: string, status: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copyStatus = status;
    } catch {
      this.copyStatus = 'Clipboard unavailable. Allow access and retry.';
    }
  }

  private copyReport() {
    if (!this.report) return;
    void this.copy(
      JSON.stringify(
        {
          ...this.report,
          estimator: 'o200k_base; text only',
          percentagesBasis: 'Estimated recorded text, not exact provider usage',
          simulation: {
            excludedSources: [...this.excluded],
            changesAgentConfiguration: false,
            estimatedRemaining: this.report.sources
              .filter(s => !this.excluded.has(s.id))
              .reduce((n, s) => n + s.tokens, 0)
          }
        },
        null,
        2
      ),
      'Report copied, including source text.'
    );
  }

  private share(tokens: number) {
    return this.report?.estimatedTokens
      ? `${((100 * tokens) / this.report.estimatedTokens).toFixed(1)}%`
      : '—';
  }

  private selectSource(source: ContextSource) {
    this.selectedSource = source.id;
    this.showOverview = false;
    this.copyStatus = '';
    void this.updateComplete.then(() => {
      const preview = this.shadowRoot?.querySelector<HTMLElement>('.preview');
      if (preview) preview.scrollTop = 0;
      if (window.matchMedia('(width < 700px)').matches)
        this.shadowRoot?.querySelector<HTMLElement>('.detail-title')?.focus();
    });
  }

  private backToSources() {
    const previous = this.selectedSource;
    this.selectedSource = null;
    this.showOverview = false;
    void this.updateComplete.then(() => {
      const target = previous
        ? this.shadowRoot?.querySelector<HTMLElement>(
            `[data-source="${previous}"]`
          )
        : this.shadowRoot?.querySelector<HTMLElement>(
            '.category-filter select'
          );
      target?.focus();
    });
  }

  private overview() {
    const report = this.report;
    if (!report) return nothing;
    return html`<div class="overview">
      <button
        class="mobile-back"
        @click=${() => {
          this.backToSources();
        }}
      >
        Back to sources
      </button>
      <h3>Context composition</h3>
      <p>Choose a category, then a source to inspect its text and origin.</p>
      <p class="muted">
        Shares divide the observable text estimate, not the model window or
        recorded input. Catalog availability does not prove invocation.
      </p>
      <table>
        <caption>
          Estimated text by category
        </caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Est. tokens</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(categories).map(([key, label]) => {
            const sources = report.sources.filter(s => s.category === key);
            const known = sources.some(s => !s.stateOnly);
            const tokens = sources.reduce((n, s) => n + s.tokens, 0);
            return html`<tr>
              <th scope="row">
                <button
                  @click=${() => {
                    this.category = key;
                    this.backToSources();
                  }}
                >
                  ${label}
                </button>
              </th>
              <td>${known ? `~${format(tokens)}` : 'Not measured'}</td>
              <td>${known ? this.share(tokens) : 'Not observed'}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
  }

  private detail(source: ContextSource) {
    // Only presentation strips known injection envelopes. Original text and
    // token estimates remain byte-for-byte untouched for inspection/copying.
    const markdown = source.text.replace(
      /^<\/?(?:INSTRUCTIONS|skills_instructions|hook_context|hook_output)\b[^>]*>\s*$/gm,
      ''
    );
    return html`<header class="detail-header">
        <button
          class="back"
          @click=${() => {
            this.backToSources();
          }}
        >
          Back to sources
        </button>
        <h3 class="detail-title" tabindex="-1">${source.title}</h3>
        <p class="source-meta">
          ${categories[source.category]} ·
          ${source.stateOnly
            ? 'Evidence only · not counted'
            : `~${format(source.tokens)} tokens · ${this.share(source.tokens)} of text estimate`}
        </p>
        <details class="provenance" open>
          <summary>Origin & delivery</summary>
          <dl>
            <dt>Source</dt>
            <dd>${source.origin || 'Recorded session message'}</dd>
            <dt>Evidence</dt>
            <dd>${source.evidence}</dd>
            <dt>Delivery</dt>
            <dd>${source.delivery}</dd>
          </dl>
        </details>
        ${source.category === 'skills'
          ? html`<p class="muted">
              Catalog description, not the full skill or proof of use.
            </p>`
          : nothing}
        <div class="text-tools">
          <div role="group" aria-label="Source text format">
            <button
              aria-pressed=${this.mode === 'markdown'}
              @click=${() => {
                this.mode = 'markdown';
              }}
            >
              Markdown
            </button>
            <button
              aria-pressed=${this.mode === 'original'}
              @click=${() => {
                this.mode = 'original';
              }}
            >
              Original
            </button>
          </div>
          <button
            @click=${() =>
              void this.copy(source.text, 'Original source text copied.')}
          >
            Copy original
          </button>
        </div>
        ${source.stateOnly
          ? nothing
          : html`<label class="simulation-control"
              ><input
                type="checkbox"
                .checked=${this.excluded.has(source.id)}
                @change=${() => {
                  this.toggleSource(source);
                }}
              />
              Exclude from estimate (simulation only)</label
            >`}
      </header>
      <div class="preview" tabindex="0" role="region" aria-label="Source text">
        ${this.mode === 'original'
          ? html`<pre>${source.text}</pre>`
          : getMarkdownTemplate(
              markdown,
              true,
              markdownTags,
              ['href', 'title'],
              false
            )}
      </div>`;
  }

  render() {
    const report = this.report;
    const filter = this.filter.trim().toLowerCase();
    const sources =
      report?.sources
        .filter(
          s =>
            (this.category === 'all' || this.category === s.category) &&
            (!filter ||
              `${s.title} ${s.origin} ${s.text} ${categories[s.category]}`
                .toLowerCase()
                .includes(filter))
        )
        .sort((a, b) => b.tokens - a.tokens) ?? [];
    const source = report?.sources.find(s => s.id === this.selectedSource);
    const saved =
      report?.sources
        .filter(s => this.excluded.has(s.id))
        .reduce((n, s) => n + s.tokens, 0) ?? 0;
    return html`<dialog
      class="panel"
      popover="manual"
      aria-labelledby="context-title"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          this.close();
        }
      }}
    >
      <header class="panel-header">
        <div>
          <h2 id="context-title">Context origins</h2>
          <p>Inspect what was recorded before a model response.</p>
        </div>
        <div class="header-actions">
          <button
            @click=${() => {
              this.copyReport();
            }}
            ?disabled=${!report || this.loading}
          >
            Copy report
          </button>
          <button
            class="close icon-button"
            aria-label="Close context origins"
            title="Close context origins"
            @click=${() => {
              this.close();
            }}
          >
            ${unsafeHTML(iconCross)}
          </button>
        </div>
      </header>
      <div class="controls">
        <label
          >Request<select
            aria-label="Request"
            .value=${String(this.selectedRequest)}
            ?disabled=${this.loading || this.checkpoints.length < 2}
            @change=${(e: Event) => {
              this.selectedRequest = Number(
                (e.target as HTMLSelectElement).value
              );
              this.analyze();
            }}
          >
            ${this.checkpoints.length
              ? this.checkpoints.map(
                  (c, i) =>
                    html`<option value=${i}>
                      ${c.label}${i === 0 ? ' · initial context' : ''}
                    </option>`
                )
              : html`<option>Loading request…</option>`}
          </select></label
        >
        <label
          >Find a source<input
            type="search"
            autofocus
            placeholder="Skill, plugin, path or text…"
            .value=${this.filter}
            @input=${(e: Event) => {
              this.filter = (e.target as HTMLInputElement).value;
              this.category = 'all';
              this.selectedSource = null;
              this.showOverview = false;
            }}
        /></label>
      </div>
      <dl class="usage" aria-label="Request token usage">
        <div>
          <dt>Input · recorded</dt>
          <dd>
            ${this.loading ? '…' : format(report?.checkpoint.input ?? null)}
          </dd>
        </div>
        <div>
          <dt>Output · recorded</dt>
          <dd>
            ${this.loading ? '…' : format(report?.checkpoint.output ?? null)}
          </dd>
        </div>
        <div>
          <dt>Text · estimated</dt>
          <dd>
            ${this.loading ? '…' : `~${format(report?.estimatedTokens ?? 0)}`}
          </dd>
        </div>
      </dl>
      <div
        class="workspace"
        ?data-detail=${!!source || this.showOverview}
        aria-busy=${this.loading}
      >
        <aside class="source-browser" aria-label="Source browser">
          <label class="category-filter"
            >Category<select
              aria-label="Source category"
              .value=${this.category}
              @change=${(e: Event) => {
                this.category = (e.target as HTMLSelectElement).value;
                this.selectedSource = null;
              }}
            >
              <option value="all">All sources</option>
              ${Object.entries(categories).map(
                ([key, label]) => html`<option value=${key}>${label}</option>`
              )}
            </select></label
          >
          <div class="list-heading">
            <span
              >${this.loading
                ? 'Analyzing…'
                : `${sources.length} sources`}</span
            ><button
              @click=${() => {
                this.selectedSource = null;
                this.showOverview = true;
              }}
            >
              Overview
            </button>
          </div>
          <div class="source-list">
            ${this.loading
              ? html`<p role="status">Analyzing recorded context…</p>`
              : sources.map(
                  s =>
                    html` <button
                      class="source-option"
                      data-source=${s.id}
                      aria-pressed=${s.id === this.selectedSource}
                      @click=${() => {
                        this.selectSource(s);
                      }}
                    >
                      <span class="source-name">${s.title}</span
                      ><span class="source-tokens"
                        >${s.stateOnly
                          ? 'Evidence only'
                          : `~${format(s.tokens)}`}</span
                      >
                      <small>${categories[s.category]} · ${s.evidence}</small>
                    </button>`
                )}
            ${!this.loading && !sources.length
              ? html`<p role="status">
                  ${filter
                    ? `No sources match “${this.filter}”.`
                    : 'No attributable text observed. This does not prove it was absent from the request.'}
                </p>`
              : nothing}
          </div>
        </aside>
        <section class="detail-pane" aria-label="Source detail">
          ${this.loading
            ? html`<div class="overview">
                <p role="status">Preparing context evidence…</p>
              </div>`
            : this.error
              ? html`<p role="alert">
                  ${this.error}<button
                    @click=${() => {
                      this.analyze();
                    }}
                  >
                    Retry
                  </button>
                </p>`
              : source
                ? this.detail(source)
                : this.overview()}
        </section>
      </div>
      <footer>
        <div class="simulation" role="status">
          ${saved
            ? html`Simulation:
                ~${format((report?.estimatedTokens ?? 0) - saved)} text tokens
                remain · ~${format(saved)} excluded.
                <button
                  @click=${() => {
                    this.excluded = new Set();
                  }}
                >
                  Reset
                </button>`
            : 'Exclusions are simulations. Codex settings and session files stay unchanged.'}
        </div>
        <details class="method">
          <summary>How these estimates work</summary>
          <p>
            Percentages divide the estimated recorded text (o200k_base), not
            exact input usage or model capacity.
          </p>
          <ul>
            ${report?.notices.map(n => html`<li>${n}</li>`)}
          </ul>
        </details>
        <p class="copy-status" role="status">${this.copyStatus}</p>
      </footer>
    </dialog>`;
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
