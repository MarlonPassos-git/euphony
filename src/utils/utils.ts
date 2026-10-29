import {
  arrow,
  computePosition,
  flip,
  hide,
  offset,
  shift,
  size
} from '@floating-ui/dom';
import DOMPurify from 'dompurify';
import {
  css,
  html,
  LitElement,
  PropertyValues,
  TemplateResult,
  unsafeCSS
} from 'lit';
import { state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';
import type { AdvancedSettings } from '../components/preference-window/preference-window';
import { BlockContent } from '../types/common-types';
import type { Conversation } from '../types/harmony-types';
import { allowedAttributes, allowedTags } from './dompurify-configs';
import type { MarkedKatexOptions } from './marked-katex-extension';
import markedKatex from './marked-katex-extension';

const DEFAULT_ALLOWED_TAGS = allowedTags;
const DEFAULT_ALLOWED_ATTRIBUTES = allowedAttributes;

const options: MarkedKatexOptions = {
  throwOnError: false,
  nonStandard: true,
  output: 'mathml'
};

/**
 * Updates the position and appearance of a popper overlay tooltip.
 * @param tooltip - The tooltip element.
 * @param anchor - The anchor element to which the tooltip is attached.
 * @param placement - The placement of the tooltip relative to the anchor
 *  ('bottom', 'left', 'top', 'right').
 * @param withArrow - Indicates whether the tooltip should have an arrow.
 * @param offsetAmount - The offset amount in pixels.
 * @param maxWidth - The maximum width of the tooltip in pixels (optional).
 */
export const updatePopperOverlay = (
  tooltip: HTMLElement,
  anchor: HTMLElement,
  placement: 'bottom' | 'left' | 'top' | 'right',
  withArrow: boolean,
  offsetAmount = 8,
  maxWidth?: number
) => {
  const arrowElement = tooltip.querySelector<HTMLElement>('.popper-arrow');

  if (!arrowElement) {
    throw new Error('Arrow element not found');
  }

  if (withArrow) {
    arrowElement.classList.remove('hidden');
    computePosition(anchor, tooltip, {
      placement: placement,
      middleware: [
        offset(offsetAmount),
        flip(),
        size({
          apply({ availableWidth, elements }) {
            if (maxWidth) {
              Object.assign(elements.floating.style, {
                maxWidth: `${Math.min(maxWidth, availableWidth)}px`
              });
            }
          }
        }),
        shift({
          // Add virtual padding to account for the header height
          padding: {
            top: 70,
            bottom: 20
          }
        }),
        arrow({ element: arrowElement }),
        hide()
      ]
    })
      .then(({ x, y, placement, middlewareData }) => {
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;

        const { x: arrowX, y: arrowY } = middlewareData.arrow!;
        let staticSide: 'bottom' | 'left' | 'top' | 'right' = 'bottom';
        if (placement.includes('top')) staticSide = 'bottom';
        if (placement.includes('right')) staticSide = 'left';
        if (placement.includes('bottom')) staticSide = 'top';
        if (placement.includes('left')) staticSide = 'right';

        tooltip.setAttribute('placement', placement);

        arrowElement.style.left = arrowX ? `${arrowX}px` : '';
        arrowElement.style.top = arrowY ? `${arrowY}px` : '';
        arrowElement.style.right = '';
        arrowElement.style.bottom = '';
        arrowElement.style[staticSide] = '-4px';

        if (middlewareData.hide?.referenceHidden) {
          tooltip.classList.add('no-show');
        } else {
          tooltip.classList.remove('no-show');
        }
      })
      .catch(() => {});
  } else {
    arrowElement.classList.add('hidden');
    computePosition(anchor, tooltip, {
      placement: placement,
      middleware: [offset(6), flip(), shift(), hide()]
    })
      .then(({ x, y, middlewareData }) => {
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;

        if (middlewareData.hide?.referenceHidden) {
          tooltip.classList.add('hidden');
        } else {
          tooltip.classList.remove('hidden');
        }
      })
      .catch(() => {});
  }
};

/**
 * Updates the position of a floating element relative to an anchor element.
 * @param floatingElement - The floating element to be positioned.
 * @param anchor - The anchor element to which the floating element is attached.
 * @param placement - The placement of the floating element relative to the
 *  anchor ('bottom', 'left', 'top', 'right').
 * @param offsetAmount - The y offset amount in pixels.
 */
export const updateFloatPosition = (
  anchor: HTMLElement,
  floatingElement: HTMLElement,
  placement: 'bottom' | 'left' | 'top' | 'right',
  offsetAmount = 6
) => {
  computePosition(anchor, floatingElement, {
    placement: placement,
    middleware: [offset(offsetAmount), flip(), shift()]
  })
    .then(({ x, y, middlewareData }) => {
      floatingElement.style.left = `${x}px`;
      floatingElement.style.top = `${y}px`;

      if (middlewareData.hide?.referenceHidden) {
        floatingElement.classList.add('hidden');
      } else {
        floatingElement.classList.remove('hidden');
      }
    })
    .catch(() => {});
};

/**
 * Generates an HTML template from a markdown string.
 *
 * @param content - The markdown content to be rendered.
 * @param shouldRenderMarkdown - Whether to render the content as markdown.
 * @param allowHTMLBlockPreview - Disable for inspectors that must show static
 *   Markdown even when the app's optional HTML-preview preference is enabled.
 * @returns The HTML template generated from the markdown content.
 */
export const getMarkdownTemplate = (
  content: string,
  shouldRenderMarkdown: boolean,
  markdownAllowedTags: string[] | null,
  markdownAllowedAttributes: string[] | null,
  allowHTMLBlockPreview = true
) => {
  if ('katex' in window) {
    //@ts-ignore
    marked.use(markedKatex(options));
  }

  // Render the message content as markdown if enabled
  let messageText = html``;

  if (shouldRenderMarkdown) {
    const domPurifyOptions = {
      ALLOWED_TAGS: DEFAULT_ALLOWED_TAGS,
      ALLOWED_ATTR: DEFAULT_ALLOWED_ATTRIBUTES
    };

    if (markdownAllowedTags !== null) {
      domPurifyOptions.ALLOWED_TAGS = markdownAllowedTags;
    }
    if (markdownAllowedAttributes !== null) {
      domPurifyOptions.ALLOWED_ATTR = markdownAllowedAttributes;
    }

    const dirtyHTML = marked(content) as string;
    const cleanHTML = DOMPurify.sanitize(
      dirtyHTML,
      domPurifyOptions
    ) as unknown as string;
    const advancedSettingString = window.localStorage.getItem(
      'preference-advanced-settings'
    );
    const advancedSettings = advancedSettingString
      ? (JSON.parse(advancedSettingString) as AdvancedSettings)
      : null;

    // Render ```html fenced blocks in a sandboxed iframe when explicitly enabled.
    if (
      allowHTMLBlockPreview &&
      advancedSettings?.renderHTMLBlock &&
      /```html[\s\S]*?```/i.test(content)
    ) {
      const htmlBlocks = Array.from(
        content.matchAll(/```html\s*([\s\S]*?)```/gi)
      ).map(match => match[1]);
      const iframeContent = htmlBlocks.join('\n');

      messageText = html`
        <div class="iframe-container">
          <div class="header">HTML Code Block Preview</div>
          <iframe sandbox srcdoc=${iframeContent}></iframe>
        </div>
      `;
    } else {
      messageText = html`<div class="message-text" markdown-rendered="">
        ${unsafeHTML(cleanHTML)}
      </div>`;
    }
  } else {
    return html`<div class="message-text">${content}</div>`;
  }

  return messageText;
};

/**
 * Creates a deferred promise that will be automatically rejected if not
 * resolved within the specified wait time.
 *
 * @template T - The type of the value that the promise resolves with.
 * @param waitTime - The time in milliseconds to wait before automatically
 * rejecting the promise.
 * @returns An object containing the promise, and wrapped resolve and reject
 * functions.
 */
export const getDeferredPromise = <T>(waitTime: number) => {
  // Create deferred promises that we will send to the parent
  const { promise, resolve, reject } = Promise.withResolvers<T>();

  // Set a timer: if the promise is not resolved in N seconds, reject it
  const promiseTimer = window.setTimeout(() => {
    reject('Timeout');
  }, waitTime);

  // Wrap the resolve and reject to clear the timer
  const wrappedResolve = (value: T) => {
    clearTimeout(promiseTimer);
    resolve(value);
  };

  const wrappedReject = (reason?: unknown) => {
    clearTimeout(promiseTimer);
    reject(reason);
  };

  return { promise, resolve: wrappedResolve, reject: wrappedReject };
};

/**
 * Converts a Blob to a base64 string.
 * @param blob - The Blob to convert.
 * @returns A promise that resolves to the base64 string.
 */
export const blobToBase64 = async (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * Digests a message using SHA-256.
 * @param message - The message to digest.
 * @returns A promise that resolves to the digest of the message.
 */
export const digestMessage = async (message: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  // Return the hash as a base64 string
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
};

/**
 * Converts a style object to a string.
 * @param styles - The style object to convert.
 * @returns The style string.
 */
export const styleToString = (styles: Record<string, string>): string => {
  return Object.entries(styles)
    .map(([key, value]) => `${key}: ${value};`)
    .join(' ');
};

export const arrayToTable = (data: unknown[][]): TemplateResult => {
  const table = html`
    <table class="array-table">
      ${data.map(
        row => html`
          <tr>
            ${row.map(cell => html` <td>${JSON.stringify(cell)}</td> `)}
          </tr>
        `
      )}
    </table>
  `;
  return table;
};

/**
 * Get custom convo labels and message labels from magic metadata field
 * @param conversation - The conversation to get custom labels from
 * @returns The custom labels
 */
export const getCustomLabelsFromMagicMetadata = (
  conversation: Conversation
) => {
  const _extractCustomMessageLabel = (label: unknown[]) => {
    let curLabel:
      | [number | string, string]
      | [number | string, string, string]
      | [number | string, string, string, string]
      | null = null;

    if (label.length === 2) {
      if (typeof label[0] === 'number') {
        curLabel = [Number(label[0]), String(label[1])] as [number, string];
      } else {
        curLabel = [String(label[0]), String(label[1])] as [string, string];
      }
    } else if (label.length === 3) {
      if (typeof label[0] === 'number') {
        curLabel = [Number(label[0]), String(label[1]), String(label[2])] as [
          number,
          string,
          string
        ];
      } else {
        curLabel = [String(label[0]), String(label[1]), String(label[2])] as [
          string,
          string,
          string
        ];
        customMessageLabels.push(curLabel);
      }
    } else if (label.length === 4) {
      if (typeof label[0] === 'number') {
        curLabel = [
          Number(label[0]),
          String(label[1]),
          String(label[2]),
          String(label[3])
        ] as [number, string, string, string];
      } else {
        curLabel = [
          String(label[0]),
          String(label[1]),
          String(label[2]),
          String(label[3])
        ] as [string, string, string, string];
      }
    }

    return curLabel;
  };

  const customLabels: string[][] = [];
  const customMessageLabels: (
    | [number | string, string]
    | [number | string, string, string]
    | [number | string, string, string, string]
  )[] = [];
  const result = {
    customLabels,
    customMessageLabels
  };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!conversation.metadata) {
    return result;
  }

  const addLabelsFromMagicFields = (metadata: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(metadata)) {
      if (
        (key.startsWith('euphony-custom-labels') ||
          key.startsWith('euphony_custom_labels')) &&
        Array.isArray(value) &&
        value.length > 0
      ) {
        for (const label of value) {
          if (Array.isArray(label) && label.length > 0) {
            customLabels.push(label.map(String));
          }
        }
      } else if (
        (key.startsWith('euphony-custom-message-labels') ||
          key.startsWith('euphony_custom_message_labels')) &&
        Array.isArray(value) &&
        value.length > 0
      ) {
        for (const label of value) {
          if (Array.isArray(label) && label.length > 0) {
            const curLabel = _extractCustomMessageLabel(label);
            if (curLabel !== null) {
              customMessageLabels.push(curLabel);
            }
          }
        }
      }
    }
  };

  // Search the magic field in the "metadata" field
  addLabelsFromMagicFields(conversation.metadata);

  // Also search the magic field in the "extras" field (from aquifer)
  if ('extras' in conversation.metadata) {
    addLabelsFromMagicFields(
      conversation.metadata.extras as Record<string, unknown>
    );
  }

  return result;
};

export class EuphonyLitElementWithBlockContents extends LitElement {
  @state()
  blockContents: BlockContent[] = [];
}

export const sharedExpandBlockContents = (
  element: LitElement | EuphonyLitElementWithBlockContents
) => {
  if (!element.shadowRoot) {
    throw new Error('Shadow root not initialized');
  }

  if ('blockContents' in element) {
    for (const blockContent of element.blockContents) {
      blockContent.isCollapsed = false;
    }
  }

  // Recursively expand the block contents of all euphony children
  const euphonyChildren = Array.from(element.shadowRoot.querySelectorAll('*'))
    .filter(e => e.tagName.startsWith('EUPHONY-'))
    .map(e => e as LitElement | EuphonyLitElementWithBlockContents);

  for (const child of euphonyChildren) {
    sharedExpandBlockContents(child);
  }

  if ('blockContents' in element && element.blockContents.length > 0) {
    element.requestUpdate();
  }
};

export const sharedCollapseBlockContents = (
  element: LitElement | EuphonyLitElementWithBlockContents
) => {
  if (!element.shadowRoot) {
    throw new Error('Shadow root not initialized');
  }

  if ('blockContents' in element) {
    for (const blockContent of element.blockContents) {
      blockContent.isCollapsed = true;
    }
  }

  // Recursively collapse the block contents of all euphony children
  const euphonyChildren = Array.from(element.shadowRoot.querySelectorAll('*'))
    .filter(e => e.tagName.startsWith('EUPHONY-'))
    .map(e => e as LitElement | EuphonyLitElementWithBlockContents);

  for (const child of euphonyChildren) {
    sharedCollapseBlockContents(child);
  }

  if ('blockContents' in element && element.blockContents.length > 0) {
    element.requestUpdate();
  }
};

export const createBase64DataURL = (mimeType: string, dataBase64: string) => {
  if (dataBase64.startsWith('data:')) {
    return dataBase64;
  }
  return `data:${mimeType};base64,${dataBase64}`;
};
