import router from '../../router';
import redraw from '../../utils/redraw';
import i18n from '../../i18n';
import popupWidget from '../shared/popup';
import spinner from '../../spinner';
import * as gameApi from '../../lichess/game';
import { handleXhrError } from '../../utils';
import { requestComputerAnalysis } from './analyseXhr';
import * as helper from '../helper';
import * as m from 'mithril';

export default {

  controller: function(root) {
    let isOpen = false;

    function open() {
      router.backbutton.stack.push(close);
      isOpen = true;
    }

    function close(fromBB) {
      if (fromBB !== 'backbutton' && isOpen) router.backbutton.stack.pop();
      isOpen = false;
    }

    return {
      open: open,
      close: close,
      isOpen: function() {
        return isOpen;
      },
      root
    };
  },

  view: function(ctrl) {
    return popupWidget(
      'analyse_menu',
      null,
      renderAnalyseMenu.bind(undefined, ctrl.root),
      ctrl.isOpen(),
      ctrl.close
    );
  }
};

function renderAnalyseMenu(ctrl) {

  const sharePGN = helper.ontap(
    ctrl.sharePGN,
    () => window.plugins.toast.show('Share PGN', 'short', 'bottom')
  );

  return m('div.analyseMenu', [
    ctrl.source === 'offline' || !gameApi.playable(ctrl.data) ? m('button[data-icon=U]', {
      key: 'continueFromHere',
      oncreate: helper.ontap(() => {
        ctrl.menu.close();
        ctrl.continuePopup.open(ctrl.vm.step.fen);
      })
    }, i18n('continueFromHere')) : null,
    ctrl.source === 'offline' || !gameApi.playable(ctrl.data) ? m('button', {
      key: 'boardEditor',
      oncreate: helper.ontap(() => router.set(`/editor/${encodeURIComponent(ctrl.vm.step.fen)}`))
    }, [m('span.fa.fa-pencil'), i18n('boardEditor')]) : null,
    ctrl.source === 'offline' || !gameApi.playable(ctrl.data) ? m('button', {
      key: 'sharePGN',
      oncreate: sharePGN
    }, [m('span.fa.fa-share-alt'), i18n('sharePGN')]) : null,
    ctrl.notes ? m('button', {
      key: 'notes',
      oncreate: helper.ontap(() => {
        ctrl.menu.close();
        ctrl.notes.open();
      })
    }, [m('span.fa.fa-pencil'), i18n('notes')]) : null,
    ctrl.isRemoteAnalysable() ? m('button', {
      key: 'requestAComputerAnalysis',
      oncreate: helper.ontap(() => {
        return requestComputerAnalysis(ctrl.data.game.id)
        .then(() => {
          ctrl.vm.analysisProgress = true;
          redraw();
        })
        .catch(handleXhrError);
      })
    }, [m('span.fa.fa-bar-chart'), i18n('requestAComputerAnalysis')]) : null,
    ctrl.vm.analysisProgress ? m('div.analysisProgress', [
      m('span', 'Analysis in progress'),
      spinner.getVdom()
    ]) : null,
    ctrl.data.analysis ? m('button', {
      key: 'open_analysis_summary',
      oncreate: helper.ontap(() => {
        ctrl.menu.close();
        ctrl.evalSummary.open();
      })
    }, [m('span.fa.fa-line-chart'), 'Analysis summary']) : null
  ]);
}

