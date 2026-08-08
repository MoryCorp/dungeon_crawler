/**
 * PRNG mulberry32 : rapide, déterministe, état tenant dans un entier 32 bits.
 *
 * Tout l'aléatoire du jeu passe par ici et l'état est sérialisé avec la partie.
 * Conséquence : une graine + une suite d'actions reproduit exactement la même
 * partie — ce qui rend la sauvegarde triviale et le debug possible.
 */
export class Rng {
  constructor(public s: number) {}

  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Entier dans [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  /** Entier dans [min, max] inclus. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1)
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
    }
    return arr
  }
}
