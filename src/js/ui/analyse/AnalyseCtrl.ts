import { debounce } from 'lodash';
import router from '../../router';
import * as chess from '../../chess';
import redraw from '../../utils/redraw';
import session from '../../session';
import sound from '../../sound';
import socket from '../../socket';
import * as gameApi from '../../lichess/game';
import settings from '../../settings';
import { isEmptyObject, handleXhrError, oppositeColor, noop, hasNetwork } from '../../utils';
import promotion from '../shared/offlineRound/promotion';
import continuePopup from '../shared/continuePopup';
import { notesCtrl } from '../shared/round/notes';
import { getPGN } from '../shared/round/roundXhr';
import * as util from './util';
import cevalCtrl from './ceval/cevalCtrl';
import crazyValid from './crazy/crazyValid';
import explorerCtrl from './explorer/explorerCtrl';
import menu from './menu';
import evalSummary from './evalSummaryPopup';
import analyseSettings from './analyseSettings';
import Analyse from './Analyse';
import treePath from './path';
import ground from './ground';
import socketHandler from './analyseSocketHandler';
import { VM, AnalysisData, AnalysisStep, SanToRole, Source, Path, AnalyseInterface, ExplorerCtrlInterface, CevalCtrlInterface, Ceval, CevalEmit } from './interfaces';

const sanToRole: SanToRole = {
  P: 'pawn',
  N: 'knight',
  B: 'bishop',
  R: 'rook',
  Q: 'queen'
};

export default class AnalyseCtrl {
  public data: AnalysisData;
  public orientation: Color;
  public source: Source;
  public vm: VM;
  public settings: any;
  public menu: any;
  public continuePopup: any;

  public chessground: Chessground.Controller;
  public analyse: AnalyseInterface;
  public ceval: CevalCtrlInterface;
  public explorer: ExplorerCtrlInterface;
  public evalSummary: any;
  public notes: any;

  private debouncedExplorerSetStep: () => void;

  public static decomposeUci(uci: string): [Pos, Pos, SanChar] {
    return [<Pos>uci.slice(0, 2), <Pos>uci.slice(2, 4), <SanChar>uci.slice(4, 5)];
  }

  public constructor(data: AnalysisData, source: Source, orientation: Color, shouldGoBack: boolean) {
    this.data = data;
    this.orientation = orientation;
    this.source = source;

    if (settings.analyse.supportedVariants.indexOf(this.data.game.variant.key) === -1) {
      window.plugins.toast.show(`Analysis board does not support ${this.data.game.variant.name} variant.`, 'short', 'center');
      router.set('/');
    }

    this.settings = analyseSettings.controller(this);
    this.menu = menu.controller(this);
    this.continuePopup = continuePopup.controller();

    this.vm = {
      shouldGoBack,
      path: null,
      pathStr: '',
      step: null,
      cgConfig: null,
      variationMenu: null,
      flip: false,
      analysisProgress: false,
      showBestMove: settings.analyse.showBestMove(),
      showComments: settings.analyse.showComments()
    };

    this.analyse = new Analyse(this.data);
    this.ceval = cevalCtrl(this.data.game.variant.key, this.allowCeval(), this.onCevalMsg);
    this.evalSummary = this.data.analysis ? evalSummary.controller(this) : null;
    this.notes = session.isConnected() && this.data.game.speed === 'correspondence' ? new (<any>notesCtrl)(this) : null;

    this.explorer = explorerCtrl(this, true);
    this.debouncedExplorerSetStep = debounce(this.explorer.setStep, this.data.pref.animationDuration + 50);

    const initialPath = location.hash ?
      treePath.default(parseInt(location.hash.replace(/#/, ''), 10)) :
      this.source === 'online' && gameApi.isPlayerPlaying(this.data) ?
        treePath.default(this.analyse.lastPly()) :
        treePath.default(this.analyse.firstPly());

    this.vm.path = initialPath;
    this.vm.pathStr = treePath.write(initialPath);

    this.showGround();
    this.initCeval();

    if (this.isRemoteAnalysable()) {
      this.connectGameSocket();
    }
  }

  public setData(data: AnalysisData) {
    this.data = data;

    this.analyse = new Analyse(this.data);
    this.ceval = cevalCtrl(this.data.game.variant.key, this.allowCeval(), this.onCevalMsg);

    const initialPath = treePath.default(0);
    this.vm.step = null;
    this.vm.path = initialPath;
    this.vm.pathStr = treePath.write(initialPath);

    this.showGround();
    this.initCeval();
  }

  public connectGameSocket = () => {
    if (hasNetwork()) {
      socket.createGame(
        this.data.url.socket,
        this.data.player.version,
        socketHandler(this, this.data.game.id, this.orientation),
        this.data.url.round
      );
    }
  }

  public flip = () => {
    this.vm.flip = !this.vm.flip;
    this.chessground.set({
      orientation: this.vm.flip ? oppositeColor(this.orientation) : this.orientation
    });
  }

  private uciToLastMove(uci: string): [Pos, Pos] {
    if (!uci) return null;
    if (uci[1] === '@') return [<Pos>uci.substr(2, 2), <Pos>uci.substr(2, 2)];
    return [<Pos>uci.substr(0, 2), <Pos>uci.substr(2, 2)];
  }

  public initCeval = () => {
    if (this.ceval.enabled()) {
      if (this.ceval.isInit()) {
        this.startCeval();
      } else {
        this.ceval.init().then(this.startCeval);
      }
    }
  }

  private startCeval = () => {
    if (this.ceval.enabled() && this.canUseCeval()) {
      this.ceval.start(this.vm.path, this.analyse.getSteps(this.vm.path));
    }
  }

  private showGround() {
    let s = this.analyse.getStep(this.vm.path);
    // might happen to have no step, for exemple with a bad step number in location
    // hash
    if (!s) {
      this.vm.path = treePath.default(this.analyse.firstPly());
      this.vm.pathStr = treePath.write(this.vm.path);
      s = this.analyse.getStep(this.vm.path);
    }

    const color: Color = s.ply % 2 === 0 ? 'white' : 'black';
    const dests = util.readDests(s.dests);
    const config = {
      fen: s.fen,
      turnColor: color,
      orientation: this.vm.flip ? oppositeColor(this.orientation) : this.orientation,
      movableColor: dests && Object.keys(dests).length > 0 ? color : null,
      dests: dests || {},
      check: s.check,
      lastMove: this.uciToLastMove(s.uci)
    };

    if (this.data.game.variant.key === 'threeCheck' && !s.checkCount) {
      s.checkCount = util.readCheckCount(s.fen);
    }

    this.vm.step = s;
    this.vm.cgConfig = config;

    if (!this.chessground) {
      this.chessground = ground.make(this.data, config, this.orientation, this.userMove, this.userNewPiece);
    } else {
      this.chessground.set(config);
    }
    if (!dests) this.debouncedDests();
  }

  public debouncedScroll = debounce(() => util.autoScroll(document.getElementById('replay')), 200);

  private updateHref = debounce(() => {
    window.history.replaceState(window.history.state, null, '#' + this.vm.step.ply);
  }, 750);

  private debouncedStartCeval = debounce(this.startCeval, 800);

  public jump = (path: Path, direction?: 'forward' | 'backward') => {
    this.vm.path = path;
    this.vm.pathStr = treePath.write(path);
    this.toggleVariationMenu(null);
    this.showGround();
    if (this.vm.step && this.vm.step.san && direction === 'forward') {
      if (this.vm.step.san.indexOf('x') !== -1) sound.capture();
      else sound.move();
    }
    this.ceval.stop();
    this.debouncedExplorerSetStep();
    this.updateHref();
    this.debouncedStartCeval();
    this.debouncedScroll();
    promotion.cancel(this, this.vm.cgConfig);
  }

  public userJump = (path: Path, direction?: 'forward' | 'backward') => {
    this.jump(path, direction);
  }

  public jumpToMain = (ply: number) => {
    this.userJump([{
      ply: ply,
      variation: null
    }]);
  }

  public jumpToIndex = (index: number) => {
    this.jumpToMain(index + 1 + this.data.game.startedAtTurn);
  }

  public canDrop = () => {
    return true;
  };

  private sendMove = (orig: Pos, dest: Pos, prom?: Role) => {
    const move: chess.MoveRequest = {
      orig: orig,
      dest: dest,
      variant: this.data.game.variant.key,
      fen: this.vm.step.fen,
      path: this.vm.pathStr
    };
    if (prom) move.promotion = prom;
    chess.move(move)
    .then(this.addStep)
    .catch(console.error.bind(console));
  }

  private userMove = (orig: Pos, dest: Pos, capture: boolean) => {
    if (capture) sound.capture();
    else sound.move();
    if (!promotion.start(this, orig, dest, this.sendMove)) this.sendMove(orig, dest);
  }

  private userNewPiece = (piece: Piece, pos: Pos) => {
    if (crazyValid.drop(this.chessground, piece, pos, this.vm.step.drops)) {
      sound.move();
      const drop = {
        role: piece.role,
        pos: pos,
        variant: this.data.game.variant.key,
        fen: this.vm.step.fen,
        path: this.vm.pathStr
      };
      chess.drop(drop)
      .then(this.addStep)
      .catch(err => {
        // catching false drops here
        console.error(err);
        this.jump(this.vm.path);
      });
    } else this.jump(this.vm.path);
  }

  public explorerMove = (uci: string) => {
    const move = AnalyseCtrl.decomposeUci(uci);
    if (uci[1] === '@') {
      this.chessground.apiNewPiece({
        color: this.chessground.data.movable.color,
        role: sanToRole[uci[0]]
      }, move[1]);
    } else if (!move[2]) {
      this.sendMove(move[0], move[1]);
    }
    else {
      this.sendMove(move[0], move[1], sanToRole[move[2].toUpperCase()]);
    }
    this.explorer.loading(true);
  }

  public addStep = ({ situation, path}: chess.MoveResponse) => {
    const step = {
      ply: situation.ply,
      dests: situation.dests,
      drops: situation.drops,
      check: situation.check,
      checkCount: situation.checkCount,
      fen: situation.fen,
      uci: situation.uciMoves[0],
      san: situation.pgnMoves[0],
      crazy: situation.crazyhouse,
      pgnMoves: this.vm.step.pgnMoves ? this.vm.step.pgnMoves.concat(situation.pgnMoves) : undefined
    };
    const newPath = this.analyse.addStep(step, treePath.read(path));
    this.jump(newPath);
    redraw();
  }

  public toggleVariationMenu = (path?: Path) => {
    if (!path) {
      this.vm.variationMenu = null;
    } else {
      const key = treePath.write(path.slice(0, 1));
      this.vm.variationMenu = this.vm.variationMenu === key ? null : key;
    }
  }

  public deleteVariation = (path: Path) => {
    const ply = path[0].ply;
    const id = path[0].variation;
    this.analyse.deleteVariation(ply, id);
    if (treePath.contains(path, this.vm.path)) this.jumpToMain(ply - 1);
    this.toggleVariationMenu(null);
  }

  public promoteVariation = (path: Path) => {
    const ply = path[0].ply;
    const id = path[0].variation;
    this.analyse.promoteVariation(ply, id);
    if (treePath.contains(path, this.vm.path))
      this.jump(this.vm.path.splice(1));
    this.toggleVariationMenu(null);
  }

  public currentAnyEval = () => {
    return this.vm.step ? (this.vm.step.rEval || this.vm.step.ceval) : null;
  }

  private allowCeval() {
    return (
      this.source === 'offline' || util.isSynthetic(this.data) || !gameApi.playable(this.data)
    ) && gameApi.analysableVariants.indexOf(this.data.game.variant.key) !== -1;
  }

  private onCevalMsg = (res: CevalEmit) => {
    this.analyse.updateAtPath(res.work.path, (step: AnalysisStep) => {
      if (step.ceval && step.ceval.depth >= res.ceval.depth) return;

      if (step.ceval === undefined)
        step.ceval = <Ceval>Object.assign({}, res.ceval);
      else
        step.ceval = <Ceval>Object.assign(step.ceval, res.ceval);

      redraw();

      const m = {
        fen: step.fen,
        orig: <Pos>res.ceval.best.slice(0, 2),
        dest: <Pos>res.ceval.best.slice(2, 4)
      }

      chess.move(m)
      .then((data: chess.MoveResponse) => {
        step.ceval.bestSan = data.situation.pgnMoves[0];
        if (res.work.path === this.vm.path) {
          redraw();
        }
      })
      .catch((err) => {
        console.error('ceval move err', m, err);
      });
    });
  }

  public gameOver() {
    if (!isEmptyObject(this.vm.step.dests)) return false;
    if (this.vm.step.check) {
      const san = this.vm.step.san;
      const checkmate = san && san[san.length - 1] === '#';
      return checkmate;
    }
    if (this.vm.step.crazy) {
      // no stalemate with full crazyhouse pockets
      const wtm = this.vm.step.fen.indexOf(' w ') !== -1;
      const p = this.vm.step.crazy.pockets[wtm ? 0 : 1];
      if (p.pawn || p.knight || p.bishop || p.rook || p.queen) return false;
    }
    return true;
  }

  public canUseCeval = () => {
    return !this.gameOver() && (!this.vm.step.rEval || !this.nextStepBest());
  }

  public nextStepBest = () => {
    return this.analyse.nextStepEvalBest(this.vm.path);
  }

  public hasAnyComputerAnalysis = () => {
    return this.data.analysis || this.ceval.enabled();
  };

  public toggleBestMove = () => {
    this.vm.showBestMove = !this.vm.showBestMove;
  }

  public toggleComments = () => {
    this.vm.showComments = !this.vm.showComments;
  }

  public sharePGN = () => {
    if (this.source === 'online') {
      getPGN(this.data.game.id)
      .then(pgn => window.plugins.socialsharing.share(pgn))
      .catch(handleXhrError);
    } else {
      const endSituation = this.data.steps[this.data.steps.length - 1];
      const white = this.data.player.color === 'white' ?
        (this.data.game.id === 'offline_ai' ? session.appUser('Anonymous') : 'Anonymous') :
        (this.data.game.id === 'offline_ai' ? this.data.opponent.username : 'Anonymous');
      const black = this.data.player.color === 'black' ?
        (this.data.game.id === 'offline_ai' ? session.appUser('Anonymous') : 'Anonymous') :
        (this.data.game.id === 'offline_ai' ? this.data.opponent.username : 'Anonymous');
      chess.pgnDump({
        variant: this.data.game.variant.key,
        initialFen: this.data.game.initialFen,
        pgnMoves: endSituation.pgnMoves,
        white,
        black
      })
      .then((res: chess.PgnDumpResponse) => window.plugins.socialsharing.share(res.pgn))
      .catch(console.error.bind(console));
    }
  }

  public isRemoteAnalysable = () => {
    return !this.data.analysis && !this.vm.analysisProgress &&
      session.isConnected() && gameApi.analysable(this.data);
  }

  private getDests = () => {
    if (!this.vm.step.dests) {
      chess.dests({
        variant: this.data.game.variant.key,
        fen: this.vm.step.fen,
        path: this.vm.pathStr
      })
      .then(({ dests, path }: chess.DestsResponse) => {
        this.analyse.addDests(dests, treePath.read(path));
        if (path === this.vm.pathStr) {
          this.showGround();
          if (this.gameOver()) this.ceval.stop();
        }
      })
      .catch(console.error.bind(console));
    }
  }

  private debouncedDests = debounce(this.getDests, 100);
}
