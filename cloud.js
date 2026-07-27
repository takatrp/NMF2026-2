(function () {
  "use strict";

  const CURRENT_PLAN_KEY = "nmf2026-2.cloud.current.v1";
  const AUTOSAVE_DELAY = 1400;
  const REFRESH_INTERVAL = 15000;
  const config = window.NMF_SUPABASE_CONFIG || {};
  const cloud = {
    client: null,
    session: null,
    current: null,
    publicPlanId: "",
    saveTimer: null,
    suppressAutosave: true,
    saving: false,
    refreshing: false,
    conflict: false,
    status: "クラウドを準備中",
    statusKind: "idle",
    lastSavedSignature: ""
  };

  const byId = (id) => document.getElementById(id);
  const cloudPayload = () => window.cloudStatePayload?.() || statePayload();
  const payloadSignature = () => JSON.stringify(cloudPayload());
  const firstRow = (data) => Array.isArray(data) ? data[0] : data;

  function setMessage(id, text, kind) {
    const el = byId(id);
    el.textContent = text || "";
    el.className = `banner ${kind || "warn"}${text ? "" : " hidden"}`;
  }

  function setStatus(text, kind) {
    cloud.status = text;
    cloud.statusKind = kind || "idle";
    renderCloudUi();
  }

  function formatUpdatedAt(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function isEditable() {
    return !!cloud.current && (cloud.current.access === "owner" || cloud.current.access === "editor");
  }

  function isConfigured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || "") &&
      /^sb_publishable_/.test(config.publishableKey || "");
  }

  function renderCloudUi() {
    const signedIn = !!cloud.session;
    const dot = byId("cloudDot");
    dot.className = `cloud-dot${cloud.statusKind === "ok" ? " online" : cloud.statusKind === "saving" ? " saving" : cloud.statusKind === "error" ? " error" : ""}`;
    byId("cloudStatus").textContent = cloud.status;
    byId("cloudPlanLabel").textContent = cloud.current ? `｜${cloud.current.title}` : "";
    byId("cloudAccountBtn").textContent = signedIn ? "アカウント" : "ログイン";
    byId("cloudSaveBtn").disabled = !signedIn || cloud.saving || cloud.conflict || !isEditable();
    const publishButton = byId("cloudPublishBtn");
    const canPublish = signedIn && cloud.current?.access === "owner";
    publishButton.classList.toggle("hidden", !canPublish);
    publishButton.disabled = !canPublish || cloud.saving || cloud.current?.id === cloud.publicPlanId;
    publishButton.textContent = cloud.current?.id === cloud.publicPlanId ? "通常URLで公開中" : "通常URLに公開";
    byId("cloudPlansBtn").disabled = !signedIn || cloud.saving;
    byId("cloudShareBtn").disabled = !signedIn || cloud.current?.access !== "owner" || cloud.saving;
    const reloadButton = byId("cloudReloadBtn");
    const publicView = cloud.current?.access === "public";
    reloadButton.classList.toggle("hidden", !cloud.conflict && !publicView);
    reloadButton.classList.toggle("btn-danger", cloud.conflict);
    reloadButton.classList.toggle("btn-soft", !cloud.conflict);
    reloadButton.textContent = publicView ? "最新版に更新" : "最新を再読込";
    byId("cloudSignedOut").classList.toggle("hidden", signedIn);
    byId("cloudSignedIn").classList.toggle("hidden", !signedIn);
    byId("cloudAccountEmail").textContent = cloud.session?.user?.email || "";

    const targetLoading = !!(getShareTokenFromUrl() || getOwnedPlanIdFromUrl()) && !cloud.current;
    const readOnly = cloud.current?.access === "viewer" || publicView;
    document.body.classList.toggle("cloud-readonly", !!readOnly);
    document.body.classList.toggle("cloud-target-loading", targetLoading);
    [
      ...document.querySelectorAll("[data-select],[data-dup],[data-template]"),
      byId("addSegBtn"),
      byId("autoBtn"),
      byId("importBtn")
    ].filter(Boolean).forEach((el) => {
      el.disabled = !!readOnly || targetLoading;
    });
  }

  function openCloudModal(id) {
    const modal = byId(id);
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    syncModalLock();
  }

  function closeCloudModal(id) {
    const modal = byId(id);
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    syncModalLock();
  }

  function closeTopCloudModal() {
    const open = ["cloudShareModal", "cloudPlansModal", "cloudAuthModal"].find((id) => byId(id).classList.contains("open"));
    if (open) closeCloudModal(open);
    return !!open;
  }

  function getAuthRedirectUrl() {
    const url = new URL(location.href);
    url.hash = "";
    return url.toString();
  }

  function getShareTokenFromUrl() {
    return new URL(location.href).searchParams.get("share") || "";
  }

  function getOwnedPlanIdFromUrl() {
    const value = new URL(location.href).searchParams.get("plan") || "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : "";
  }

  function buildCloudShareUrl(token) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("share", token);
    return url.toString();
  }

  function setOwnedPlanParam(planId) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    if (planId) url.searchParams.set("plan", planId);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function setSharedPlanParam(token) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    if (token) url.searchParams.set("share", token);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function persistCurrent() {
    if (!cloud.current) {
      localStorage.removeItem(CURRENT_PLAN_KEY);
      return;
    }
    localStorage.setItem(CURRENT_PLAN_KEY, JSON.stringify({
      id: cloud.current.id,
      access: cloud.current.access,
      shareToken: cloud.current.shareToken || ""
    }));
  }

  function normalizePlan(row, access, shareToken) {
    return {
      id: row.id,
      title: row.title,
      revision: Number(row.revision),
      viewToken: row.view_token || "",
      editToken: row.edit_token || "",
      updatedAt: row.updated_at || "",
      access,
      shareToken: shareToken || ""
    };
  }

  function applyCloudPlan(row, access, shareToken, updateUrl = true) {
    cloud.suppressAutosave = true;
    if (window.applyCloudStatePayload) window.applyCloudStatePayload(row.payload);
    else applyStatePayload(row.payload);
    render();
    cloud.current = normalizePlan(row, access, shareToken);
    cloud.current.keepBaseUrl = access === "owner" && !updateUrl;
    if (access === "owner" && updateUrl) setOwnedPlanParam(row.id);
    else if (access === "viewer" || access === "editor") setSharedPlanParam(shareToken);
    else if (access === "public") setSharedPlanParam("");
    cloud.lastSavedSignature = payloadSignature();
    cloud.conflict = false;
    persistCurrent();
    cloud.suppressAutosave = false;
    setStatus(access === "viewer" ? "閲覧のみ" : `保存済み ${formatUpdatedAt(row.updated_at)}`, "ok");
  }

  function clearCurrentPlan(clearUrl) {
    cloud.current = null;
    cloud.lastSavedSignature = "";
    cloud.conflict = false;
    persistCurrent();
    if (clearUrl) setOwnedPlanParam("");
    document.body.classList.remove("cloud-readonly");
    setStatus(cloud.session ? "ローカル編集中" : "未ログイン", cloud.session ? "ok" : "idle");
  }

  function isConflictError(error) {
    return error?.code === "40001" || /PLAN_CONFLICT/i.test(error?.message || "");
  }

  function handleCloudError(error, fallback) {
    console.error(error);
    setStatus(fallback || "クラウドエラー", "error");
  }

  async function sendLoginLink() {
    const email = byId("cloudEmail").value.trim();
    if (!email || !email.includes("@")) {
      setMessage("cloudAuthMessage", "メールアドレスを確認してください。", "bad");
      return;
    }
    byId("cloudSendLinkBtn").disabled = true;
    setMessage("cloudAuthMessage", "ログインリンクを送信しています。", "warn");
    const { error } = await cloud.client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: getAuthRedirectUrl(),
        shouldCreateUser: true
      }
    });
    byId("cloudSendLinkBtn").disabled = false;
    if (error) {
      setMessage("cloudAuthMessage", `送信できませんでした：${error.message}`, "bad");
      return;
    }
    setMessage("cloudAuthMessage", "メールを送信しました。届いたリンクを開いてください。", "ok");
  }

  async function signOut() {
    const { error } = await cloud.client.auth.signOut();
    if (error) {
      setMessage("cloudAuthMessage", `ログアウトできませんでした：${error.message}`, "bad");
      return;
    }
    closeCloudModal("cloudAuthModal");
  }

  async function listOwnedPlans() {
    setMessage("cloudPlansMessage", "一覧を読み込んでいます。", "warn");
    const { data, error } = await cloud.client
      .from("seminar_plans")
      .select("id,title,revision,updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      setMessage("cloudPlansMessage", `一覧を読み込めません：${error.message}`, "bad");
      byId("cloudPlanList").replaceChildren();
      return;
    }
    setMessage("cloudPlansMessage", "", "warn");
    renderPlanList(data || []);
  }

  function renderPlanList(plans) {
    const root = byId("cloudPlanList");
    root.replaceChildren();
    if (!plans.length) {
      const empty = document.createElement("p");
      empty.className = "small";
      empty.textContent = "クラウドに保存された設計はまだありません。";
      root.appendChild(empty);
      return;
    }
    plans.forEach((plan) => {
      const row = document.createElement("div");
      row.className = "cloud-plan-row";

      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = plan.title;
      const meta = document.createElement("div");
      meta.className = "cloud-plan-meta";
      meta.textContent = `版 ${plan.revision}｜更新 ${formatUpdatedAt(plan.updated_at)}${cloud.current?.id === plan.id ? "｜編集中" : ""}`;
      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "cloud-plan-actions";
      const open = document.createElement("button");
      open.className = "btn-primary";
      open.textContent = "開く";
      open.addEventListener("click", () => loadOwnedPlan(plan.id, true));
      const remove = document.createElement("button");
      remove.className = "btn-danger";
      remove.textContent = "削除";
      remove.addEventListener("click", () => deleteOwnedPlan(plan.id, plan.title));
      actions.append(open, remove);

      row.append(info, actions);
      root.appendChild(row);
    });
  }

  async function createPlan() {
    const title = byId("cloudNewPlanName").value.trim();
    if (!title) {
      setMessage("cloudPlansMessage", "設計名を入力してください。", "bad");
      return;
    }
    cloud.saving = true;
    renderCloudUi();
    setMessage("cloudPlansMessage", "クラウドへ保存しています。", "warn");
    const payload = cloudPayload();
    const { data, error } = await cloud.client.rpc("save_owned_seminar_plan", {
      p_plan_id: null,
      p_title: title,
      p_payload: payload,
      p_expected_revision: null
    });
    const row = firstRow(data);
    cloud.saving = false;
    if (error || !row) {
      setMessage("cloudPlansMessage", `保存できません：${error?.message || "結果がありません"}`, "bad");
      renderCloudUi();
      return;
    }
    cloud.current = normalizePlan(row, "owner", "");
    setOwnedPlanParam(row.id);
    cloud.lastSavedSignature = JSON.stringify(payload);
    cloud.conflict = false;
    persistCurrent();
    setMessage("cloudPlansMessage", "クラウドへ保存しました。", "ok");
    setStatus(`保存済み ${formatUpdatedAt(row.updated_at)}`, "ok");
    await listOwnedPlans();
  }

  async function loadOwnedPlan(planId, closeList, updateUrl = true) {
    setStatus("クラウドから読込中", "saving");
    const { data, error } = await cloud.client
      .from("seminar_plans")
      .select("id,title,payload,revision,view_token,edit_token,updated_at")
      .eq("id", planId)
      .single();
    if (error) {
      handleCloudError(error, "設計を読み込めません");
      return false;
    }
    applyCloudPlan(data, "owner", "", updateUrl);
    if (closeList) closeCloudModal("cloudPlansModal");
    return true;
  }

  async function loadLatestOwnedPlan() {
    setStatus("最新版を確認中", "saving");
    const { data, error } = await cloud.client
      .from("seminar_plans")
      .select("id,title,payload,revision,view_token,edit_token,updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) {
      handleCloudError(error, "最新版を読み込めません");
      return false;
    }
    const row = firstRow(data);
    if (!row) {
      setStatus("クラウド接続済み", "ok");
      return true;
    }
    applyCloudPlan(row, "owner", "", false);
    return true;
  }

  async function loadPublicPlan(applyPlan = true) {
    if (applyPlan) setStatus("公開最新版を読込中", "saving");
    const { data, error } = await cloud.client.rpc("load_public_seminar_plan");
    const row = firstRow(data);
    if (error || !row) {
      if (applyPlan) {
        handleCloudError(error || new Error("公開設計が設定されていません"), "公開最新版を読み込めません");
      }
      return false;
    }
    cloud.publicPlanId = row.id;
    if (applyPlan) {
      applyCloudPlan(row, "public", "", false);
      setStatus(`公開最新版 ${formatUpdatedAt(row.updated_at)}`, "ok");
    } else {
      renderCloudUi();
    }
    return true;
  }

  async function publishCurrentPlan() {
    if (!cloud.session || cloud.current?.access !== "owner") return;
    if (!confirm(`「${cloud.current.title}」を通常URLで公開しますか？ログインしていない人も閲覧できるようになります。`)) return;
    cloud.saving = true;
    renderCloudUi();
    setStatus("通常URLへ公開中", "saving");
    const { data, error } = await cloud.client.rpc("publish_owned_seminar_plan", {
      p_plan_id: cloud.current.id
    });
    const row = firstRow(data);
    cloud.saving = false;
    if (error || !row) {
      handleCloudError(error || new Error("公開結果がありません"), "通常URLへ公開できません");
      return;
    }
    cloud.publicPlanId = row.id;
    setStatus(`通常URLで公開中 ${formatUpdatedAt(row.updated_at)}`, "ok");
    renderCloudUi();
  }

  async function loadSharedPlan(token, closeList) {
    setStatus("共有設計を読込中", "saving");
    const { data, error } = await cloud.client.rpc("load_shared_seminar_plan", {
      p_token: token
    });
    const row = firstRow(data);
    if (error || !row) {
      handleCloudError(error || new Error("共有設計が見つかりません"), "共有設計を開けません");
      return false;
    }
    applyCloudPlan(row, row.can_edit ? "editor" : "viewer", token);
    if (closeList) closeCloudModal("cloudPlansModal");
    return true;
  }

  async function deleteOwnedPlan(planId, title) {
    if (!confirm(`「${title}」をクラウドから削除しますか？`)) return;
    const { error } = await cloud.client.from("seminar_plans").delete().eq("id", planId);
    if (error) {
      setMessage("cloudPlansMessage", `削除できません：${error.message}`, "bad");
      return;
    }
    if (cloud.current?.id === planId) clearCurrentPlan(true);
    await listOwnedPlans();
  }

  async function saveCloudPlan(options) {
    const manual = !!options?.manual;
    if (!cloud.session) {
      openCloudModal("cloudAuthModal");
      return false;
    }
    if (!cloud.current) {
      if (manual) {
        openCloudModal("cloudPlansModal");
        await listOwnedPlans();
        byId("cloudNewPlanName").focus();
      }
      return false;
    }
    if (!isEditable() || cloud.saving || cloud.conflict) return false;

    const payload = cloudPayload();
    const signature = JSON.stringify(payload);
    if (!manual && signature === cloud.lastSavedSignature) return true;

    cloud.saving = true;
    setStatus("保存中", "saving");
    const rpcName = cloud.current.access === "owner"
      ? "save_owned_seminar_plan"
      : "save_shared_seminar_plan";
    const args = cloud.current.access === "owner"
      ? {
          p_plan_id: cloud.current.id,
          p_title: cloud.current.title,
          p_payload: payload,
          p_expected_revision: cloud.current.revision
        }
      : {
          p_token: cloud.current.shareToken,
          p_title: cloud.current.title,
          p_payload: payload,
          p_expected_revision: cloud.current.revision
        };
    const { data, error } = await cloud.client.rpc(rpcName, args);
    cloud.saving = false;

    if (error) {
      if (isConflictError(error)) {
        cloud.conflict = true;
        setStatus("別の人が先に更新しました", "error");
        setMessage("cloudPlansMessage", "JSON保存で編集中の内容を退避してから、最新を再読込してください。", "bad");
      } else {
        handleCloudError(error, "クラウド保存に失敗");
      }
      renderCloudUi();
      return false;
    }

    const row = firstRow(data);
    if (!row) {
      handleCloudError(new Error("保存結果がありません"), "クラウド保存に失敗");
      return false;
    }
    cloud.current = Object.assign({}, cloud.current, {
      title: row.title,
      revision: Number(row.revision),
      updatedAt: row.updated_at,
      viewToken: row.view_token || cloud.current.viewToken,
      editToken: row.edit_token || cloud.current.editToken
    });
    cloud.lastSavedSignature = signature;
    persistCurrent();
    setStatus(`保存済み ${formatUpdatedAt(row.updated_at)}`, "ok");
    return true;
  }

  window.scheduleCloudAutosave = function () {
    if (cloud.suppressAutosave || !cloud.session || !isEditable() || cloud.conflict) return;
    clearTimeout(cloud.saveTimer);
    cloud.saveTimer = setTimeout(() => saveCloudPlan({ manual: false }), AUTOSAVE_DELAY);
  };

  async function refreshLatestWhenSafe() {
    if (cloud.current?.access === "public") return false;
    if (
      !cloud.session ||
      !cloud.current ||
      cloud.saving ||
      cloud.refreshing ||
      cloud.conflict ||
      document.visibilityState === "hidden" ||
      window.hasPendingCardEdit?.() ||
      payloadSignature() !== cloud.lastSavedSignature
    ) {
      return false;
    }

    cloud.refreshing = true;
    let data;
    let error;
    if (cloud.current.access === "owner") {
      ({ data, error } = await cloud.client
        .from("seminar_plans")
        .select("id,title,payload,revision,view_token,edit_token,updated_at")
        .eq("id", cloud.current.id)
        .single());
    } else {
      ({ data, error } = await cloud.client.rpc("load_shared_seminar_plan", {
        p_token: cloud.current.shareToken
      }));
      data = firstRow(data);
    }
    cloud.refreshing = false;

    if (error) {
      console.warn("最新版を確認できませんでした", error);
      return false;
    }
    const row = firstRow(data);
    if (!row || Number(row.revision) <= cloud.current.revision) return true;

    const updateUrl = !cloud.current.keepBaseUrl;
    applyCloudPlan(row, cloud.current.access, cloud.current.shareToken, updateUrl);
    setStatus(`最新版を反映 ${formatUpdatedAt(row.updated_at)}`, "ok");
    return true;
  }

  async function reloadCurrentPlan() {
    if (!cloud.current) return;
    let ok;
    if (cloud.current.access === "public") {
      ok = await loadPublicPlan(true);
    } else if (cloud.current.access === "owner") {
      ok = await loadOwnedPlan(cloud.current.id, false, !cloud.current.keepBaseUrl);
    } else {
      ok = await loadSharedPlan(cloud.current.shareToken, false);
    }
    if (ok) cloud.conflict = false;
    renderCloudUi();
  }

  function showShareModal() {
    if (cloud.current?.access !== "owner") return;
    byId("cloudViewLink").value = buildCloudShareUrl(cloud.current.viewToken);
    byId("cloudEditLink").value = buildCloudShareUrl(cloud.current.editToken);
    setMessage("cloudShareMessage", "", "warn");
    openCloudModal("cloudShareModal");
  }

  async function rotateShareLinks() {
    if (!cloud.current || cloud.current.access !== "owner") return;
    if (!confirm("現在の共有リンクを無効にして、新しいリンクを発行しますか？")) return;
    byId("cloudRotateLinksBtn").disabled = true;
    const { data, error } = await cloud.client.rpc("rotate_seminar_plan_share_tokens", {
      p_plan_id: cloud.current.id
    });
    byId("cloudRotateLinksBtn").disabled = false;
    const row = firstRow(data);
    if (error || !row) {
      setMessage("cloudShareMessage", `再発行できません：${error?.message || "結果がありません"}`, "bad");
      return;
    }
    cloud.current.viewToken = row.view_token;
    cloud.current.editToken = row.edit_token;
    cloud.current.revision = Number(row.revision || cloud.current.revision);
    cloud.current.updatedAt = row.updated_at || cloud.current.updatedAt;
    persistCurrent();
    byId("cloudViewLink").value = buildCloudShareUrl(cloud.current.viewToken);
    byId("cloudEditLink").value = buildCloudShareUrl(cloud.current.editToken);
    setMessage("cloudShareMessage", "新しい共有リンクを発行しました。以前のリンクは無効です。", "ok");
  }

  async function copyCloudLink(kind) {
    const id = kind === "edit" ? "cloudEditLink" : "cloudViewLink";
    await copyText(byId(id).value);
  }

  async function handleSession(session) {
    const wasSignedIn = !!cloud.session;
    cloud.session = session || null;
    setMessage("cloudAuthMessage", "", "warn");
    if (!session) {
      cloud.suppressAutosave = true;
      clearCurrentPlan();
      cloud.suppressAutosave = false;
      if (getShareTokenFromUrl() || getOwnedPlanIdFromUrl()) {
        setStatus("クラウド設計を開くにはログイン", "error");
        openCloudModal("cloudAuthModal");
      } else {
        await loadPublicPlan(true);
      }
      renderCloudUi();
      return;
    }

    setStatus("クラウド接続済み", "ok");
    renderCloudUi();
    if (!wasSignedIn) await loadPublicPlan(false);
    const urlToken = getShareTokenFromUrl();
    if (urlToken) {
      await loadSharedPlan(urlToken, false);
      return;
    }
    const urlPlanId = getOwnedPlanIdFromUrl();
    if (urlPlanId) {
      await loadOwnedPlan(urlPlanId, false);
      return;
    }

    if (!wasSignedIn) await loadLatestOwnedPlan();
  }

  function bindEvents() {
    byId("cloudAccountBtn").addEventListener("click", () => openCloudModal("cloudAuthModal"));
    byId("cloudSendLinkBtn").addEventListener("click", sendLoginLink);
    byId("cloudSignOutBtn").addEventListener("click", signOut);
    byId("cloudSaveBtn").addEventListener("click", () => saveCloudPlan({ manual: true }));
    byId("cloudPublishBtn").addEventListener("click", publishCurrentPlan);
    byId("cloudPlansBtn").addEventListener("click", async () => {
      openCloudModal("cloudPlansModal");
      await listOwnedPlans();
    });
    byId("cloudCreateBtn").addEventListener("click", createPlan);
    byId("cloudShareBtn").addEventListener("click", showShareModal);
    byId("cloudReloadBtn").addEventListener("click", reloadCurrentPlan);
    byId("cloudRotateLinksBtn").addEventListener("click", rotateShareLinks);

    document.querySelectorAll("[data-cloud-close]").forEach((button) => {
      button.addEventListener("click", () => closeCloudModal(button.dataset.cloudClose));
    });
    document.querySelectorAll("[data-copy-cloud]").forEach((button) => {
      button.addEventListener("click", () => copyCloudLink(button.dataset.copyCloud));
    });
    ["cloudAuthModal", "cloudPlansModal", "cloudShareModal"].forEach((id) => {
      byId(id).addEventListener("click", (event) => {
        if (event.target.id === id) closeCloudModal(id);
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeTopCloudModal();
      if (event.key === "Enter" && event.target.id === "cloudEmail") sendLoginLink();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshLatestWhenSafe();
    });
    window.addEventListener("focus", refreshLatestWhenSafe);
  }

  async function init() {
    bindEvents();
    if (!isConfigured()) {
      setStatus("Supabase設定がありません", "error");
      return;
    }
    if (!window.supabase?.createClient) {
      setStatus("クラウド機能を読み込めません", "error");
      return;
    }

    cloud.client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
      }
    });
    const { data, error } = await cloud.client.auth.getSession();
    if (error) {
      handleCloudError(error, "ログイン状態を確認できません");
    } else {
      await handleSession(data.session);
    }
    cloud.client.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => handleSession(session), 0);
    });
    window.setInterval(refreshLatestWhenSafe, REFRESH_INTERVAL);
    cloud.suppressAutosave = false;

    if (!cloud.session && (getShareTokenFromUrl() || getOwnedPlanIdFromUrl())) {
      setStatus("クラウド設計を開くにはログイン", "error");
      openCloudModal("cloudAuthModal");
    }
    renderCloudUi();
  }

  init().catch((error) => handleCloudError(error, "クラウド初期化に失敗"));
})();
