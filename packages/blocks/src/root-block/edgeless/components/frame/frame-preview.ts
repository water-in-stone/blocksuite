import type { BlockModel, Query } from '@blocksuite/store';

import {
  type EditorHost,
  ShadowlessElement,
  WithDisposable,
} from '@blocksuite/block-std';
import { deserializeXYWH } from '@blocksuite/global/utils';
import { Bound } from '@blocksuite/global/utils';
import { DisposableGroup, debounce } from '@blocksuite/global/utils';
import { BlockViewType, type Doc, nanoid } from '@blocksuite/store';
import { type PropertyValues, css, html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import type { FrameBlockModel } from '../../../../frame-block/frame-model.js';
import type { NoteBlockModel } from '../../../../note-block/note-model.js';
import type {
  ElementUpdatedData,
  SurfaceBlockModel,
} from '../../../../surface-block/surface-model.js';
import type { SurfaceRefPortal } from '../../../../surface-ref-block/surface-ref-portal.js';
import type { SurfaceRefRenderer } from '../../../../surface-ref-block/surface-ref-renderer.js';
import type { EdgelessRootBlockComponent } from '../../edgeless-root-block.js';

import { SpecProvider } from '../../../../specs/index.js';
import '../../../../surface-ref-block/surface-ref-portal.js';
import { isTopLevelBlock } from '../../utils/query.js';

type RefElement = Exclude<BlockSuite.EdgelessModel, NoteBlockModel>;

const DEFAULT_PREVIEW_CONTAINER_WIDTH = 280;
const DEFAULT_PREVIEW_CONTAINER_HEIGHT = 166;

const styles = css`
  .frame-preview-container {
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    position: relative;
  }

  .frame-preview-surface-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    overflow: hidden;
  }

  .frame-preview-surface-viewport {
    max-width: 100%;
    box-sizing: border-box;
    margin: 0 auto;
    position: relative;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }

  .frame-preview-surface-canvas-container {
    height: 100%;
    width: 100%;
    position: relative;
  }
`;

@customElement('frame-preview')
export class FramePreview extends WithDisposable(ShadowlessElement) {
  private _clearDocDisposables = () => {
    this._docDisposables?.dispose();
    this._docDisposables = null;
  };

  private _clearEdgelessDisposables = () => {
    this._edgelessDisposables?.dispose();
    this._edgelessDisposables = null;
  };

  private _clearFrameDisposables = () => {
    this._frameDisposables?.dispose();
    this._frameDisposables = null;
  };

  private _debounceHandleElementUpdated = debounce(
    (data: ElementUpdatedData) => {
      const { id, oldValues, props } = data;
      if (!props.xywh) return;
      // if element is moved in frame, refresh viewport
      if (this._overlapWithFrame(id)) {
        this._refreshViewport();
      } else if (oldValues.xywh) {
        // if element is moved out of frame, refresh viewport
        const oldBound = Bound.deserialize(oldValues.xywh as string);
        const frameBound = Bound.deserialize(this.frame.xywh);
        if (oldBound.isOverlapWithBound(frameBound)) {
          this._refreshViewport();
        }
      }
    },
    1000 / 30
  );

  private _docDisposables: DisposableGroup | null = null;

  private _edgelessDisposables: DisposableGroup | null = null;

  private _frameDisposables: DisposableGroup | null = null;

  private _getViewportWH = (referencedModel: RefElement) => {
    const [, , w, h] = deserializeXYWH(referencedModel.xywh);

    let scale = 1;
    if (this.fillScreen) {
      scale = Math.max(this.surfaceWidth / w, this.surfaceHeight / h);
    } else {
      scale = Math.min(this.surfaceWidth / w, this.surfaceHeight / h);
    }

    return {
      width: w * scale,
      height: h * scale,
    };
  };

  private _overlapWithFrame = (id: string) => {
    const ele = this.edgeless?.service.getElementById(id);
    if (!ele || !ele.xywh) return false;

    const frameBound = Bound.deserialize(this.frame.xywh);
    const eleBound = Bound.deserialize(ele.xywh);
    return frameBound.isOverlapWithBound(eleBound);
  };

  private _renderModel = (model: BlockModel) => {
    const query: Query = {
      mode: 'include',
      match: [{ id: model.id, viewType: BlockViewType.Display }],
    };
    this._disposables.add(() => {
      doc.blockCollection.clearQuery(query);
    });
    const doc = model.doc.blockCollection.getDoc({ query });
    const previewSpec = SpecProvider.getInstance().getSpec('page:preview');
    return this.host.renderSpecPortal(doc, previewSpec.value);
  };

  private _surfaceRefRenderer!: SurfaceRefRenderer;

  private _surfaceRefRendererId: string = nanoid();

  static override styles = styles;

  private _attachRenderer() {
    if (
      this._surfaceRefRenderer?.surfaceRenderer.canvas.isConnected ||
      !this.container ||
      !this.blocksPortal
    )
      return;

    this.surfaceRenderer.viewport.setContainer(this.container);
    this.surfaceRenderer.attach(this.container);
    if (this.blocksPortal.isUpdatePending) {
      this.blocksPortal.updateComplete
        .then(() => {
          this.blocksPortal.setStackingCanvas(
            this._surfaceRefRenderer.surfaceRenderer.stackingCanvas
          );
        })
        .catch(console.error);
    } else {
      this.blocksPortal.setStackingCanvas(
        this._surfaceRefRenderer.surfaceRenderer.stackingCanvas
      );
    }
  }

  private _cleanupSurfaceRefRenderer() {
    const surfaceRefService = this._surfaceRefService;
    if (!surfaceRefService) return;
    surfaceRefService.removeRenderer(this._surfaceRefRendererId);
  }

  private _refreshViewport() {
    if (!this.frame || !this._surfaceService) {
      return;
    }

    const referencedModel = this.frame;

    // trigger a rerender to update element's size
    // and set viewport after element's size has been updated
    this.updateComplete
      .then(() => {
        this.surfaceRenderer.viewport.onResize();
        this.surfaceRenderer.viewport.setViewportByBound(
          Bound.fromXYWH(deserializeXYWH(referencedModel.xywh))
        );

        this.blocksPortal?.setViewport(this.surfaceRenderer.viewport);
      })
      .catch(console.error);
  }

  private _renderSurfaceContent(referencedModel: FrameBlockModel) {
    const { width, height } = this._getViewportWH(referencedModel);
    const backgroundColor = this.surfaceRenderer.generateColorProperty(
      referencedModel.background,
      '--affine-platte-transparent'
    );

    return html`<div
      class="frame-preview-surface-container"
      style=${styleMap({
        width: `${this.surfaceWidth}px`,
        height: `${this.surfaceHeight}px`,
      })}
    >
      <div
        style=${styleMap({
          backgroundColor,
          borderRadius: '4px',
        })}
      >
        <div
          class="frame-preview-surface-viewport"
          style=${styleMap({
            width: `${width}px`,
            height: `${height}px`,
            aspectRatio: `${width} / ${height}`,
          })}
        >
          <surface-ref-portal
            .doc=${this.doc}
            .host=${this.host}
            .refModel=${referencedModel}
            .renderModel=${this._renderModel}
          ></surface-ref-portal>
          <div class="frame-preview-surface-canvas-container">
            <!-- attach canvas here -->
          </div>
        </div>
      </div>
    </div>`;
  }

  private _setDocDisposables(doc: Doc) {
    this._clearDocDisposables();
    this._docDisposables = new DisposableGroup();

    this._docDisposables.add(
      doc.slots.blockUpdated.on(event => {
        const { type } = event;
        // Should only check for add and delete events, the update event will be handled by the surface renderer
        if (type === 'update') return;

        const model = doc.getBlockById(event.id);
        if (!model || !isTopLevelBlock(model) || !model.xywh) return;

        const frameBound = Bound.deserialize(this.frame.xywh);
        const modelBound = Bound.deserialize(model.xywh);
        if (frameBound.containsPoint([modelBound.x, modelBound.y])) {
          this._refreshViewport();
        }
      })
    );
  }

  private _setEdgelessDisposables(edgeless: EdgelessRootBlockComponent | null) {
    this._clearEdgelessDisposables();
    if (!edgeless) return;
    this._edgelessDisposables = new DisposableGroup();
    this._edgelessDisposables.add(
      edgeless.slots.navigatorSettingUpdated.on(({ fillScreen }) => {
        if (fillScreen !== undefined) {
          this.fillScreen = fillScreen;
          this._refreshViewport();
        }
      })
    );
    this._edgelessDisposables.add(
      edgeless.service.surface.elementAdded.on(({ id }) => {
        if (this._overlapWithFrame(id)) {
          this._refreshViewport();
        }
      })
    );
    this._edgelessDisposables.add(
      edgeless.service.surface.elementUpdated.on(
        this._debounceHandleElementUpdated
      )
    );
    this._edgelessDisposables.add(
      edgeless.service.surface.elementRemoved.on(() => this._refreshViewport())
    );
  }

  private _setFrameDisposables(frame: FrameBlockModel) {
    this._clearFrameDisposables();
    this._frameDisposables = new DisposableGroup();
    this._frameDisposables.add(
      frame.propsUpdated.on(() => {
        this.requestUpdate();
        this._refreshViewport();
      })
    );
  }

  private _setupSurfaceRefRenderer() {
    const surfaceRefService = this._surfaceRefService;
    if (!surfaceRefService) return;
    const renderer = surfaceRefService.getRenderer(
      this._surfaceRefRendererId,
      this.doc,
      true
    );
    this._surfaceRefRenderer = renderer;

    this._disposables.add(
      renderer.slots.surfaceModelChanged.on(model => {
        this._surfaceModel = model;
      })
    );
    this._disposables.add(
      renderer.slots.surfaceRendererRefresh.on(() => {
        this.requestUpdate();
      })
    );

    this._disposables.add(
      this._surfaceRefRenderer.surfaceService.layer.slots.layerUpdated.on(
        () => {
          this.blocksPortal.setStackingCanvas(
            this._surfaceRefRenderer.surfaceRenderer.stackingCanvas
          );
        }
      )
    );

    renderer.mount();
  }

  private get _surfaceRefService() {
    return this.host.spec.getService('affine:surface-ref');
  }

  private get _surfaceService() {
    return this.host?.std.spec.getService('affine:surface');
  }

  private _tryLoadFillScreen() {
    if (!this.edgeless) return;

    this.fillScreen =
      this.edgeless.service.editPropsStore.getStorage('presentFillScreen') ??
      false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._tryLoadFillScreen();
    this._setupSurfaceRefRenderer();
    this._setDocDisposables(this.doc);
    this._setEdgelessDisposables(this.edgeless);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupSurfaceRefRenderer();
    this._clearEdgelessDisposables();
    this._clearDocDisposables();
    this._clearFrameDisposables();
  }

  override firstUpdated() {
    this._refreshViewport();
    this._setFrameDisposables(this.frame);
  }

  override render() {
    const { _surfaceModel, frame, host, _surfaceService } = this;
    const noContent =
      !_surfaceModel || !frame || !frame.xywh || !host || !_surfaceService;

    return html`<div class="frame-preview-container">
      ${noContent ? nothing : this._renderSurfaceContent(frame)}
    </div>`;
  }

  override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has('edgeless')) {
      if (this.edgeless) {
        this._setEdgelessDisposables(this.edgeless);
      } else {
        this._clearEdgelessDisposables();
      }
      setTimeout(() => {
        this._refreshViewport();
      });
    }

    if (_changedProperties.has('doc')) {
      if (this.doc) {
        this._setDocDisposables(this.doc);
      }
    }

    this._attachRenderer();
  }

  get surfaceRenderer() {
    return this._surfaceRefRenderer.surfaceRenderer;
  }

  @state()
  private accessor _surfaceModel: SurfaceBlockModel | null = null;

  @query('.frame-preview-surface-container surface-ref-portal')
  accessor blocksPortal!: SurfaceRefPortal;

  @query('.frame-preview-surface-canvas-container')
  accessor container!: HTMLDivElement;

  @property({ attribute: false })
  accessor doc!: Doc;

  @property({ attribute: false })
  accessor edgeless: EdgelessRootBlockComponent | null = null;

  @state()
  accessor fillScreen = false;

  @property({ attribute: false })
  accessor frame!: FrameBlockModel;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor surfaceHeight: number = DEFAULT_PREVIEW_CONTAINER_HEIGHT;

  @property({ attribute: false })
  accessor surfaceWidth: number = DEFAULT_PREVIEW_CONTAINER_WIDTH;
}

declare global {
  interface HTMLElementTagNameMap {
    'frame-preview': FramePreview;
  }
}
