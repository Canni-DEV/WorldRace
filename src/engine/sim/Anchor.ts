import { Vector3 } from 'three';

export class Anchor {
  private readonly position = new Vector3();

  public constructor(initialPosition: Vector3) {
    this.position.copy(initialPosition);
  }

  public getPosition(): Readonly<Vector3> {
    return this.position;
  }

  public setPosition(position: Vector3): void {
    this.position.copy(position);
  }

  public applyFloatingOffset(offsetEast: number, offsetNorth: number): void {
    this.position.x -= offsetEast;
    this.position.z -= offsetNorth;
  }

  public getDistanceToLocalOriginXZ(): number {
    return Math.hypot(this.position.x, this.position.z);
  }
}
