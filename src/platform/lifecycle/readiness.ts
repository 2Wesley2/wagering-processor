/** Estado de prontidão compartilhado entre health check e coordenador de shutdown. */
export class ReadinessState {
  private draining = false;

  isDraining(): boolean {
    return this.draining;
  }

  startDraining(): void {
    this.draining = true;
  }
}
