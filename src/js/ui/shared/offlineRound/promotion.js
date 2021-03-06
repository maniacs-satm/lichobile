import * as utils from '../../../utils';
import redraw from '../../../utils/redraw';
import * as helper from '../../helper';
import settings from '../../../settings';
import * as m from 'mithril';

var promoting = false;

function promote(ground, key, role) {
  var pieces = {};
  var piece = ground.data.pieces[key];
  if (piece && piece.role === 'pawn') {
    pieces[key] = {
      color: piece.color,
      role: role
    };
    ground.setPieces(pieces);
  }
}

function start(ctrl, orig, dest, callback) {
  var piece = ctrl.chessground.data.pieces[dest];
  if (piece && piece.role === 'pawn' && (
    (dest[1] === '1' && ctrl.chessground.data.turnColor === 'white') ||
    (dest[1] === '8' && ctrl.chessground.data.turnColor === 'black'))) {
    promoting = {
      orig: orig,
      dest: dest,
      callback: callback
    };
    redraw();
    return true;
  }
  return false;
}

function finish(ground, role) {
  if (promoting) promote(ground, promoting.dest, role);
  if (promoting.callback) promoting.callback(promoting.orig, promoting.dest, role);
  promoting = false;
}

function cancel(ctrl, cgConfig) {
  if (promoting) {
    promoting = false;
    ctrl.chessground.set(cgConfig);
    redraw();
  }
}

export function view(ctrl) {
  const pieces = ['queen', 'knight', 'rook', 'bishop'];
  if (ctrl.data && ctrl.data.game.variant.key === 'antichess') {
    pieces.push('king');
  }

  return promoting ? m('div.overlay.open', [m('div#promotion_choice', {
    className: settings.general.theme.piece(),
    style: { top: (helper.viewportDim().vh - 100) / 2 + 'px' }
  }, pieces.map(function(role) {
    return m('piece.' + role + '.' + ctrl.data.player.color, {
      oncreate: helper.ontap(utils.f(finish, ctrl.chessground, role))
    });
  }))]) : null;
}

export default {
  start,
  cancel
};
