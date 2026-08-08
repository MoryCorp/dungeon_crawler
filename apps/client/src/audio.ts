/**
 * Son du jeu — tout est synthétisé en WebAudio, aucun fichier.
 *
 * Deux étages : des effets courts déclenchés par les événements de l'engine,
 * et une musique générative qui tourne en continu. La musique n'est pas une
 * boucle enregistrée : c'est un petit orchestre de couches (bourdon, pulsation,
 * mélodie, souffle) piloté par **l'intensité de la Directrice** — le même
 * signal qui décide des vagues décide de la tension musicale. Quand elle
 * monte, le filtre s'ouvre, la pulsation accélère, un bourdon dissonant se
 * glisse dessous ; quand le joueur souffle, il ne reste qu'une nappe et
 * quelques notes clairsemées. La bande-son EST la Directrice, audible.
 *
 * Chaque étage change de tonique et de gamme (dérivées du numéro d'étage,
 * donc identiques pour toute l'équipe), et descend globalement vers le grave :
 * plus on est profond, plus c'est sombre.
 */

/** Gamme mineure naturelle, en demi-tons depuis la tonique. */
const MODE = [0, 2, 3, 5, 7, 8, 10]
/** Notes de mélodie : pentatonique mineure, clairsemée et sans fausse note. */
const PENTA = [0, 3, 5, 7, 10, 12, 15]
/** Toniques par étage, en demi-tons — un cycle qui évite de retomber pareil. */
const ROOTS = [0, -4, 3, -2, 5, -7, 1, -5]

const st = (semitones: number): number => 2 ** (semitones / 12)

export class GameAudio {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private sfxBus!: GainNode
  private musicBus!: GainNode

  // Couches musicales persistantes.
  private droneFilter!: BiquadFilterNode
  private droneOscs: OscillatorNode[] = []
  private tensionGain!: GainNode
  private tensionOsc: OscillatorNode | null = null

  private root = 110 // La tonique courante, en Hz.
  private floor = 1
  private intensity = 0
  private shownIntensity = 0
  private beat = 0
  private nextBeatAt = 0
  private schedulerId: number | null = null

  private muted = localStorage.getItem('dc:muted') === '1'
  /** Anti-mitraille : au plus un effet d'un type donné par petite fenêtre. */
  private lastPlayed = new Map<string, number>()

  /** À appeler depuis un geste utilisateur (clic « rejoindre ») : politique navigateur. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume()
      return
    }
    const ctx = new AudioContext()
    this.ctx = ctx

    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -18
    compressor.ratio.value = 4
    compressor.connect(ctx.destination)

    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 1
    this.master.connect(compressor)

    this.sfxBus = ctx.createGain()
    this.sfxBus.gain.value = 0.5
    this.sfxBus.connect(this.master)

    this.musicBus = ctx.createGain()
    this.musicBus.gain.value = 0.4
    this.musicBus.connect(this.master)

    this.buildDrone()
    this.nextBeatAt = ctx.currentTime + 0.1
    this.schedulerId = window.setInterval(() => this.schedule(), 90)
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    localStorage.setItem('dc:muted', this.muted ? '1' : '0')
    if (this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05)
    }
    return this.muted
  }

  get isMuted(): boolean {
    return this.muted
  }

  /** Intensité de la Directrice, entre 0 et 1 — arrive avec chaque paquet d'état. */
  setIntensity(x: number): void {
    this.intensity = Math.max(0, Math.min(1, x))
  }

  setFloor(floor: number): void {
    if (floor === this.floor && this.ctx) return
    this.floor = floor
    // La tonique cycle, et l'ensemble baisse d'un demi-ton tous les deux
    // étages : la profondeur s'entend.
    const semis = ROOTS[(floor - 1) % ROOTS.length]! - Math.floor((floor - 1) / 2)
    this.root = 110 * st(semis)
    if (this.ctx) {
      for (const [i, osc] of this.droneOscs.entries()) {
        const target = this.root * (i === 0 ? 0.5 : 1) * (i === 2 ? st(7) / 2 : 1)
        osc.frequency.setTargetAtTime(target, this.ctx.currentTime, 1.2)
      }
      if (this.tensionOsc) {
        this.tensionOsc.frequency.setTargetAtTime(this.root * st(1), this.ctx.currentTime, 1.2)
      }
    }
  }

  // --- Musique ----------------------------------------------------------------

  /** Bourdon permanent : tonique, octave, quinte — le sol harmonique du donjon. */
  private buildDrone(): void {
    const ctx = this.ctx!
    this.droneFilter = ctx.createBiquadFilter()
    this.droneFilter.type = 'lowpass'
    this.droneFilter.frequency.value = 320
    this.droneFilter.Q.value = 0.7

    const droneGain = ctx.createGain()
    droneGain.gain.value = 0.11
    this.droneFilter.connect(droneGain)
    droneGain.connect(this.musicBus)

    const make = (freq: number, detune: number, type: OscillatorType): OscillatorNode => {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = freq
      osc.detune.value = detune
      osc.connect(this.droneFilter)
      osc.start()
      return osc
    }
    this.droneOscs = [
      make(this.root * 0.5, -4, 'sawtooth'),
      make(this.root, 4, 'sawtooth'),
      make((this.root * st(7)) / 2, 0, 'triangle'),
    ]

    // Le bourdon de tension : une seconde mineure au-dessus de la tonique,
    // inaudible au repos, qui frotte de plus en plus fort quand ça chauffe.
    this.tensionGain = ctx.createGain()
    this.tensionGain.gain.value = 0
    this.tensionGain.connect(this.musicBus)
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = this.root * st(1)
    osc.connect(this.tensionGain)
    osc.start()
    this.tensionOsc = osc
  }

  /**
   * Horloge musicale : planifie les temps un peu en avance, à un tempo qui suit
   * l'intensité (52 bpm au calme, 132 au pic).
   */
  private schedule(): void {
    const ctx = this.ctx!
    // Lissage : la musique réagit en une seconde ou deux, jamais d'à-coup.
    this.shownIntensity += (this.intensity - this.shownIntensity) * 0.12
    const heat = this.shownIntensity

    this.droneFilter.frequency.setTargetAtTime(300 + heat * 1900, ctx.currentTime, 0.4)
    this.tensionGain.gain.setTargetAtTime(heat * heat * 0.05, ctx.currentTime, 0.4)

    const bpm = 52 + heat * 80
    const beatLen = 60 / bpm

    while (this.nextBeatAt < ctx.currentTime + 0.25) {
      const t = Math.max(this.nextBeatAt, ctx.currentTime)
      this.playBeat(t, beatLen, heat)
      this.nextBeatAt += beatLen
      this.beat++
    }
  }

  private playBeat(t: number, beatLen: number, heat: number): void {
    // Pulsation sourde : un cœur qui bat, discret au calme, insistant au pic.
    if (heat > 0.12 || this.beat % 2 === 0) {
      this.kick(t, 0.02 + heat * 0.09)
    }
    // Souffle sur les contretemps quand ça chauffe.
    if (heat > 0.45) {
      this.hat(t + beatLen / 2, (heat - 0.45) * 0.055)
    }
    // Mélodie clairsemée, surtout dans le calme : c'est la respiration.
    const chance = 0.34 - heat * 0.26
    if (this.rand() < chance) {
      const degree = PENTA[Math.floor(this.rand() * PENTA.length)]!
      const freq = this.root * 2 * st(degree)
      this.pluck(t, freq, 0.035, 1.6)
      // Parfois une tierce en écho, comme une réponse.
      if (this.rand() < 0.3) {
        this.pluck(t + beatLen * 0.75, freq * st(3), 0.022, 1.2)
      }
    }
    // Une nappe qui s'ouvre de temps en temps, accordée sur le mode.
    if (this.beat % 16 === 0) {
      const degree = MODE[Math.floor(this.rand() * MODE.length)]!
      this.swell(t, this.root * st(degree), 0.03, beatLen * 12)
    }
  }

  /** Hasard musical : pas besoin d'être partagé, juste d'être vivant. */
  private rand(): number {
    return Math.random()
  }

  // --- Instruments -------------------------------------------------------------

  private kick(t: number, gain: number): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, t)
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.12)
    env.gain.setValueAtTime(gain, t)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
    osc.connect(env)
    env.connect(this.musicBus)
    osc.start(t)
    osc.stop(t + 0.25)
  }

  private hat(t: number, gain: number): void {
    const ctx = this.ctx!
    const src = this.noiseSource()
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 6000
    const env = ctx.createGain()
    env.gain.setValueAtTime(gain, t)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    src.connect(filter)
    filter.connect(env)
    env.connect(this.musicBus)
    src.start(t)
    src.stop(t + 0.06)
  }

  private pluck(t: number, freq: number, gain: number, decay: number): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = freq
    env.gain.setValueAtTime(gain, t)
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    osc.connect(env)
    env.connect(this.musicBus)
    osc.start(t)
    osc.stop(t + decay + 0.05)
  }

  private swell(t: number, freq: number, gain: number, dur: number): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + dur * 0.4)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(env)
    env.connect(this.musicBus)
    osc.start(t)
    osc.stop(t + dur + 0.1)
  }

  // --- Effets -----------------------------------------------------------------

  private noiseSource(): AudioBufferSourceNode {
    const ctx = this.ctx!
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buffer
    return src
  }

  /** Un ton simple avec enveloppe et glissando optionnel. */
  private tone(opts: {
    freq: number
    to?: number
    type?: OscillatorType
    dur: number
    gain: number
    at?: number
  }): void {
    const ctx = this.ctx!
    const t = ctx.currentTime + (opts.at ?? 0)
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = opts.type ?? 'square'
    osc.frequency.setValueAtTime(opts.freq, t)
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur)
    env.gain.setValueAtTime(opts.gain, t)
    env.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur)
    osc.connect(env)
    env.connect(this.sfxBus)
    osc.start(t)
    osc.stop(t + opts.dur + 0.05)
  }

  private burst(opts: { dur: number; gain: number; from: number; to: number; at?: number }): void {
    const ctx = this.ctx!
    const t = ctx.currentTime + (opts.at ?? 0)
    const src = this.noiseSource()
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(opts.from, t)
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to), t + opts.dur)
    const env = ctx.createGain()
    env.gain.setValueAtTime(opts.gain, t)
    env.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur)
    src.connect(filter)
    filter.connect(env)
    env.connect(this.sfxBus)
    src.start(t)
    src.stop(t + opts.dur + 0.05)
  }

  /** Garde anti-mitraille : trois coups le même tick = un seul son. */
  private gate(kind: string, ms: number): boolean {
    if (!this.ctx) return false
    const now = performance.now()
    const last = this.lastPlayed.get(kind) ?? -Infinity
    if (now - last < ms) return false
    this.lastPlayed.set(kind, now)
    return true
  }

  /**
   * Traduit un événement de l'engine en son. `selfId` distingue ce qui NOUS
   * arrive (plus fort, plus grave) de ce qui arrive autour.
   */
  onEvent(ev: { t: string } & Record<string, unknown>, selfId: string): void {
    if (!this.ctx) return
    switch (ev.t) {
      case 'swing':
        if (this.gate('swing', 70)) {
          this.burst({ dur: 0.08, gain: 0.1, from: 2600, to: 700 })
        }
        break

      case 'hit': {
        const toSelf = ev.to === selfId
        if (!this.gate(toSelf ? 'hurt' : 'hit', 60)) break
        if (toSelf) {
          this.burst({ dur: 0.16, gain: 0.4, from: 900, to: 120 })
          this.tone({ freq: 150, to: 70, type: 'sawtooth', dur: 0.18, gain: 0.22 })
        } else {
          this.burst({ dur: 0.09, gain: 0.22, from: 1400, to: 300 })
        }
        break
      }

      case 'blast':
        if (this.gate('blast', 100)) {
          this.burst({ dur: 0.5, gain: 0.5, from: 700, to: 60 })
          this.tone({ freq: 90, to: 34, type: 'sine', dur: 0.5, gain: 0.4 })
        }
        break

      case 'death':
        if (ev.kind === 'monster') {
          if (this.gate('mdeath', 80)) {
            this.burst({ dur: 0.14, gain: 0.16, from: 800, to: 150 })
            this.tone({ freq: 220, to: 90, type: 'triangle', dur: 0.14, gain: 0.1 })
          }
        } else {
          this.tone({ freq: 220, to: 55, type: 'sawtooth', dur: 0.9, gain: 0.3 })
        }
        break

      case 'downed':
        this.tone({ freq: 330, to: 110, type: 'square', dur: 0.5, gain: 0.25 })
        this.tone({ freq: 466, to: 155, type: 'square', dur: 0.5, gain: 0.18, at: 0.08 })
        break

      case 'revived':
        for (const [i, f] of [330, 415, 494, 660].entries()) {
          this.tone({ freq: f, type: 'triangle', dur: 0.25, gain: 0.14, at: i * 0.09 })
        }
        break

      case 'pickup':
        switch (ev.kind) {
          case 'xp':
            if (this.gate('xp', 50)) {
              this.tone({ freq: 990 + Math.random() * 220, type: 'sine', dur: 0.07, gain: 0.05 })
            }
            break
          case 'bone':
            // Un cliquetis sec, plus grave que l'orbe d'XP, tout aussi discret.
            if (this.gate('bone', 60)) {
              this.tone({ freq: 480 + Math.random() * 90, type: 'square', dur: 0.04, gain: 0.04 })
            }
            break
          case 'heart':
            this.tone({ freq: 392, type: 'triangle', dur: 0.3, gain: 0.16 })
            this.tone({ freq: 588, type: 'triangle', dur: 0.3, gain: 0.12, at: 0.07 })
            break
          case 'key':
            for (const [i, f] of [660, 880, 1320].entries()) {
              this.tone({ freq: f, type: 'square', dur: 0.12, gain: 0.09, at: i * 0.07 })
            }
            break
          case 'weapon':
            this.burst({ dur: 0.12, gain: 0.2, from: 3600, to: 1400 })
            this.tone({ freq: 1180, type: 'triangle', dur: 0.2, gain: 0.1 })
            break
          case 'chest':
            this.tone({ freq: 260, type: 'triangle', dur: 0.2, gain: 0.14 })
            break
        }
        break

      case 'levelup':
        if (ev.id === selfId) {
          for (const [i, f] of [523, 659, 784, 1046].entries()) {
            this.tone({ freq: f, type: 'square', dur: 0.22, gain: 0.11, at: i * 0.08 })
          }
        }
        break

      case 'keydrop':
        this.tone({ freq: 880, to: 660, type: 'triangle', dur: 0.4, gain: 0.12 })
        break

      case 'unlock':
        this.tone({ freq: 110, to: 55, type: 'square', dur: 0.5, gain: 0.2 })
        this.burst({ dur: 0.35, gain: 0.2, from: 500, to: 90, at: 0.1 })
        break

      case 'descend':
        this.burst({ dur: 1.1, gain: 0.2, from: 1200, to: 70 })
        this.tone({ freq: 165, to: 82, type: 'triangle', dur: 1.0, gain: 0.14 })
        break

      /**
       * La signature de la Directrice : deux voix à une seconde mineure
       * d'écart qui enflent depuis rien. On ne sait pas d'où ça vient — c'est
       * le but. Quand tu l'entends, quelque chose arrive.
       */
      case 'horde': {
        const ctx = this.ctx
        const t = ctx.currentTime
        for (const f of [this.root, this.root * st(1)]) {
          const osc = ctx.createOscillator()
          const env = ctx.createGain()
          osc.type = 'sawtooth'
          osc.frequency.value = f
          env.gain.setValueAtTime(0.0001, t)
          env.gain.exponentialRampToValueAtTime(0.16, t + 0.7)
          env.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
          osc.connect(env)
          env.connect(this.sfxBus)
          osc.start(t)
          osc.stop(t + 1.7)
        }
        this.kick(t + 0.65, 0.16)
        break
      }
    }
  }
}
