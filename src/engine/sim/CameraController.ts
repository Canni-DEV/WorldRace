import { Euler, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { Anchor } from './Anchor';

const BASE_MOVE_SPEED_METERS_PER_SECOND = 40;
const FAST_MOVE_MULTIPLIER = 3;
const LOOK_SENSITIVITY = 0.0025;
const MAX_PITCH = Math.PI / 2 - 0.01;

export class CameraController {
  private readonly camera: PerspectiveCamera;
  private readonly inputElement: HTMLElement;
  private readonly anchor: Anchor;
  private readonly activeKeys = new Set<string>();
  private readonly movementVector = new Vector3();
  private readonly forwardVector = new Vector3();
  private readonly rightVector = new Vector3();
  private readonly upVector = new Vector3(0, 1, 0);
  private readonly rotationEuler = new Euler(0, 0, 0, 'YXZ');
  private isLooking = false;
  private yaw = 0;
  private pitch = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.activeKeys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.activeKeys.delete(event.code);
  };

  private readonly onWindowBlur = (): void => {
    this.activeKeys.clear();
    this.isLooking = false;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 2) {
      return;
    }

    this.isLooking = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.inputElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 2) {
      return;
    }

    this.isLooking = false;
    if (this.inputElement.hasPointerCapture(event.pointerId)) {
      this.inputElement.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.isLooking) {
      return;
    }

    const deltaX = event.clientX - this.lastPointerX;
    const deltaY = event.clientY - this.lastPointerY;

    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    this.yaw -= deltaX * LOOK_SENSITIVITY;
    this.pitch -= deltaY * LOOK_SENSITIVITY;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  };

  public constructor(camera: PerspectiveCamera, inputElement: HTMLElement, anchor: Anchor) {
    this.camera = camera;
    this.inputElement = inputElement;
    this.anchor = anchor;

    this.rotationEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = this.rotationEuler.y;
    this.pitch = this.rotationEuler.x;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    this.inputElement.addEventListener('contextmenu', this.onContextMenu);
    this.inputElement.addEventListener('pointerdown', this.onPointerDown);
    this.inputElement.addEventListener('pointerup', this.onPointerUp);
    this.inputElement.addEventListener('pointermove', this.onPointerMove);
  }

  public update(deltaSeconds: number): void {
    this.rotationEuler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.rotationEuler);

    const forwardInput = this.readAxis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const strafeInput = this.readAxis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const verticalInput = this.readAxis(['Space', 'KeyE'], ['ControlLeft', 'ControlRight', 'KeyQ']);
    const hasInput = forwardInput !== 0 || strafeInput !== 0 || verticalInput !== 0;

    if (hasInput) {
      this.forwardVector.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      this.rightVector.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
      this.movementVector.set(0, 0, 0);

      if (forwardInput !== 0) {
        this.movementVector.addScaledVector(this.forwardVector, forwardInput);
      }

      if (strafeInput !== 0) {
        this.movementVector.addScaledVector(this.rightVector, strafeInput);
      }

      if (verticalInput !== 0) {
        this.movementVector.addScaledVector(this.upVector, verticalInput);
      }

      if (this.movementVector.lengthSq() > 1) {
        this.movementVector.normalize();
      }

      const speedMultiplier = this.isFastModeActive() ? FAST_MOVE_MULTIPLIER : 1;
      const frameDistance = BASE_MOVE_SPEED_METERS_PER_SECOND * speedMultiplier * deltaSeconds;
      this.camera.position.addScaledVector(this.movementVector, frameDistance);
    }

    this.anchor.setPosition(this.camera.position);
  }

  public applyFloatingOffset(offsetEast: number, offsetNorth: number): void {
    this.camera.position.x -= offsetEast;
    this.camera.position.z -= offsetNorth;
    this.anchor.applyFloatingOffset(offsetEast, offsetNorth);
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.inputElement.removeEventListener('contextmenu', this.onContextMenu);
    this.inputElement.removeEventListener('pointerdown', this.onPointerDown);
    this.inputElement.removeEventListener('pointerup', this.onPointerUp);
    this.inputElement.removeEventListener('pointermove', this.onPointerMove);
  }

  private readAxis(positiveKeys: readonly string[], negativeKeys: readonly string[]): number {
    const positive = positiveKeys.some((key) => this.activeKeys.has(key)) ? 1 : 0;
    const negative = negativeKeys.some((key) => this.activeKeys.has(key)) ? 1 : 0;
    return positive - negative;
  }

  private isFastModeActive(): boolean {
    return this.activeKeys.has('ShiftLeft') || this.activeKeys.has('ShiftRight');
  }
}
