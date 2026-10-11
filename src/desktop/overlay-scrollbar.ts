import { Directive, ElementRef, NgZone, OnDestroy, OnInit, inject } from '@angular/core';

const hideDelayMs = 700;
const fadeInMs = 200;
const fadeOutMs = 400;
const thumbWidthPx = 6;

function overlayThumbBox(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  inset = 0,
): { size: number; offset: number } | null {
  const track = clientHeight - inset * 2;
  if (clientHeight <= 0 || track <= 0 || scrollHeight <= clientHeight) {
    return null;
  }
  const size = Math.round(Math.min(track, Math.max(24, (track * clientHeight) / scrollHeight)));
  const maxScroll = scrollHeight - clientHeight;
  const travel = Math.max(0, track - size);
  const offset = maxScroll === 0 ? 0 : Math.round((scrollTop / maxScroll) * travel);
  return { size, offset };
}

function scrollbarInset(element: HTMLElement): number {
  if (!element.classList.contains('dialog-panel')) {
    return 0;
  }
  const style = getComputedStyle(element);
  const paddingTop = Number.parseFloat(style.paddingTop);
  const paddingBottom = Number.parseFloat(style.paddingBottom);
  if (!Number.isFinite(paddingTop) || !Number.isFinite(paddingBottom)) {
    return 0;
  }
  return Math.min(paddingTop, paddingBottom);
}

function ensureOverlayScrollbarStyles(): void {
  if (document.getElementById('gm-overlay-scrollbar')) {
    return;
  }
  const style = document.createElement('style');
  style.id = 'gm-overlay-scrollbar';
  style.textContent = `
.overlay-scroll {
  scrollbar-width: none;
}
.overlay-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.overlay-scrollbar-anchor {
  position: sticky;
  top: 0;
  left: calc(100% - 8px);
  display: block;
  width: 8px;
  height: 0;
  min-height: 0;
  flex: 0 0 0px;
  align-self: stretch;
  margin: 0;
  padding: 0;
  border: 0;
  line-height: 0;
  font-size: 0;
  z-index: 1;
  pointer-events: none;
  list-style: none;
}
.overlay-scrollbar {
  position: absolute;
  top: 2px;
  right: 2px;
  width: ${thumbWidthPx}px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 55%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity ${fadeOutMs}ms cubic-bezier(0.4, 0, 0.2, 1);
}
.overlay-scrollbar.is-visible {
  opacity: 1;
  pointer-events: auto;
  transition: opacity ${fadeInMs}ms cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .overlay-scrollbar,
  .overlay-scrollbar.is-visible {
    transition: none;
  }
}
.dialog-panel.overlay-scroll {
  box-sizing: border-box;
  overflow: auto;
  max-height: calc(100vh - 64px);
  min-height: 0;
}
`;
  document.head.appendChild(style);
}

@Directive({
  selector: '[gmOverlayScroll]',
  standalone: true,
  host: {
    class: 'overlay-scroll',
  },
})
export class OverlayScroll implements OnInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private anchor: HTMLElement | null = null;
  private thumb: HTMLElement | null = null;
  private scrolling = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private dragMove: ((event: PointerEvent) => void) | null = null;
  private dragUp: (() => void) | null = null;
  private dragging = false;

  ngOnInit(): void {
    ensureOverlayScrollbarStyles();
    const element = this.host.nativeElement;
    element.style.scrollbarWidth = 'none';
    const anchor = document.createElement('span');
    anchor.className = 'overlay-scrollbar-anchor';
    anchor.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('span');
    thumb.className = 'overlay-scrollbar';
    thumb.setAttribute('data-testid', 'overlay-scrollbar');
    thumb.setAttribute('aria-hidden', 'true');
    anchor.appendChild(thumb);
    element.insertBefore(anchor, element.firstChild);
    this.anchor = anchor;
    this.thumb = thumb;
    this.zone.runOutsideAngular(() => {
      element.addEventListener('scroll', this.onScroll, { passive: true });
      thumb.addEventListener('pointerdown', this.onThumbDown);
    });
  }

  ngOnDestroy(): void {
    const element = this.host.nativeElement;
    element.removeEventListener('scroll', this.onScroll);
    this.thumb?.removeEventListener('pointerdown', this.onThumbDown);
    this.clearDrag();
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
    }
    this.anchor?.remove();
  }

  private onScroll = (): void => {
    this.scrolling = true;
    this.refresh();
    this.armHide();
  };

  private onThumbDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const element = this.host.nativeElement;
    const inset = scrollbarInset(element);
    const box = overlayThumbBox(element.scrollTop, element.scrollHeight, element.clientHeight, inset);
    if (!box) {
      return;
    }
    this.dragging = true;
    this.refresh();
    const startY = event.clientY;
    const startScroll = element.scrollTop;
    const maxScroll = element.scrollHeight - element.clientHeight;
    const travel = Math.max(1, element.clientHeight - inset * 2 - box.size);
    this.clearDrag();
    this.dragMove = (move: PointerEvent) => {
      element.scrollTop = startScroll + ((move.clientY - startY) / travel) * maxScroll;
      this.scrolling = true;
      this.refresh();
    };
    this.dragUp = () => {
      this.dragging = false;
      this.clearDrag();
      this.armHide();
    };
    window.addEventListener('pointermove', this.dragMove);
    window.addEventListener('pointerup', this.dragUp);
  };

  private armHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
    }
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.scrolling = false;
      this.refresh();
    }, hideDelayMs);
  }

  private clearDrag(): void {
    if (this.dragMove) {
      window.removeEventListener('pointermove', this.dragMove);
    }
    if (this.dragUp) {
      window.removeEventListener('pointerup', this.dragUp);
    }
    this.dragMove = null;
    this.dragUp = null;
  }

  private refresh(): void {
    const thumb = this.thumb;
    if (!thumb) {
      return;
    }
    const element = this.host.nativeElement;
    const inset = scrollbarInset(element);
    const box = overlayThumbBox(element.scrollTop, element.scrollHeight, element.clientHeight, inset);
    thumb.classList.toggle('is-visible', box !== null && (this.scrolling || this.dragging));
    if (!box) {
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0px)';
      return;
    }
    thumb.style.height = `${box.size}px`;
    thumb.style.transform = `translateY(${box.offset}px)`;
  }
}
