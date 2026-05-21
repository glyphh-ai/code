// @ts-nocheck
/**
 * customize.ts — the Customize and Schedules slides (toggled from the
 * left-rail nav items). Each is a slide whose body is custom markup.
 * Depends on ctx.pushSlide, ctx.popSlide, ctx.slideStack.
 */
export function initCustomize(ctx) {
  const $ = (id) => document.getElementById(id);
  const { pushSlide, popSlide, slideStack } = ctx;

  const CUSTOMIZE_APP = { id: "__customize", name: "Customize", letter: "★", color: "#25C75E" };
  const SCHEDULES_APP = { id: "__schedules", name: "Schedules", letter: "⏱", color: "#25C75E" };

  function renderCustomizeBody() {
    return `
      <div class="ws-customize">
        <div class="ws-customize-intro">
          Things you build once and reuse. Apps and Agents live in the left rail.
        </div>
        <div class="ws-customize-section">
          <div class="ws-customize-head">
            <span class="label">Skills</span>
            <button class="ws-btn" data-add="skill">+ New skill</button>
          </div>
          <div class="ws-customize-list">
            <div class="ws-customize-row"><span class="name">RPA workflow</span><span class="hint">— record once, run forever</span></div>
            <div class="ws-customize-row"><span class="name">Email drafting</span><span class="hint">— tone + sign-off</span></div>
          </div>
        </div>
        <div class="ws-customize-section">
          <div class="ws-customize-head">
            <span class="label">Layouts</span>
            <button class="ws-btn" data-add="layout">+ New layout</button>
          </div>
          <div class="ws-customize-list">
            <div class="ws-customize-row"><span class="name">Inbox</span><span class="hint">— gmail + calendar split</span></div>
            <div class="ws-customize-row"><span class="name">Standup</span><span class="hint">— linear + slack + notes</span></div>
          </div>
        </div>
        <div class="ws-customize-section">
          <div class="ws-customize-head">
            <span class="label">Drips</span>
            <button class="ws-btn" data-add="drip">+ New drip</button>
          </div>
          <div class="ws-customize-list">
            <div class="ws-customize-row"><span class="name">Daily standup</span><span class="hint">— 9am, sequence of 3</span></div>
            <div class="ws-customize-row"><span class="name">Weekly digest</span><span class="hint">— Fri 5pm</span></div>
          </div>
        </div>
      </div>
    `;
  }
  function renderSchedulesBody() {
    return `
      <div class="ws-customize">
        <div class="ws-customize-intro">
          Run a skill on a cadence. Outputs land in Activity (right rail).
        </div>
        <div class="ws-customize-section">
          <div class="ws-customize-head">
            <span class="label">Schedules</span>
            <button class="ws-btn" data-add="schedule">+ New schedule</button>
          </div>
          <div class="ws-customize-list">
            <div class="ws-customize-row">
              <span class="name">RPA workflow</span>
              <span class="hint">— every weekday at 8am · last run: 2h ago · <a href="#" data-activity="open">view output</a></span>
            </div>
            <div class="ws-customize-row">
              <span class="name">Email triage</span>
              <span class="hint">— hourly · last run: 12m ago · <a href="#" data-activity="open">view output</a></span>
            </div>
            <div class="ws-customize-row">
              <span class="name">Weekly digest</span>
              <span class="hint">— Fri 5pm · last run: yesterday · <a href="#" data-activity="open">view output</a></span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function toggleInternalSlide(internalId, app, bodyFn) {
    const top = slideStack[slideStack.length - 1];
    if (top && top.app && top.app.id === internalId) { popSlide(); return; }
    pushSlide({ ...app, __body: bodyFn() });
  }
  function toggleCustomizeSlide() { toggleInternalSlide("__customize", CUSTOMIZE_APP, renderCustomizeBody); }
  function toggleSchedulesSlide() { toggleInternalSlide("__schedules", SCHEDULES_APP, renderSchedulesBody); }

  const openCustomize = $("open-customize");
  if (openCustomize) openCustomize.addEventListener("click", toggleCustomizeSlide);
  const openSchedules = $("open-schedules");
  if (openSchedules) openSchedules.addEventListener("click", toggleSchedulesSlide);
}
