const grid = document.getElementById("grid");
const subtitle = document.getElementById("subtitle");
const lightbox = document.getElementById("lightbox");
const mediaStage = document.getElementById("mediaStage");
const lightboxImg = document.getElementById("lightboxImg");
const lightboxVideo = document.getElementById("lightboxVideo");
const counter = document.getElementById("counter");
const shuffleBtn = document.getElementById("shuffleBtn");
const filterBtn = document.getElementById("filterBtn");
const filterIcon = document.getElementById("filterIcon");
const slideshowBtn = document.getElementById("slideshowBtn");
const slideshowToggleBtn = document.getElementById("slideshowToggleBtn");
const slideshowToggleIcon = document.getElementById("slideshowToggleIcon");
const pager = document.getElementById("pager");
const pagePrev = document.getElementById("pagePrev");
const pageNext = document.getElementById("pageNext");
const closeBtn = document.getElementById("closeBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");

const PAGE_SIZE = 86;

// Everything gallery.json gave us, in its own order.
let allItems = [];
// The same items in a random order, regenerated whenever randomisation is
// switched on — so changing the photo/video filter doesn't reshuffle.
let shuffledItems = [];
// What's actually on screen: the chosen order, then the chosen filter.
let items = [];
// `current` indexes the whole filtered gallery, not the visible page — the
// lightbox walks straight across page boundaries.
let current = 0;
// Which page of thumbnails the grid is showing (0-based).
let page = 0;
let randomize = true;
// Index into FILTERS below. Neither this nor `randomize` is persisted —
// a reload puts both back to "random, everything".
let filterIndex = 0;
// Maps the id in the URL hash back to a gallery index, so a pasted link
// opens straight onto that photo/video.
const idToIndex = new Map();
// True when opening the lightbox pushed a history entry we own, so closing
// it can just go back. False when we landed directly on a shared link and
// there's nothing of ours behind us.
let pushedEntry = false;
// Set while we're closing in response to back/forward, so the close handler
// doesn't try to touch history again.
let closingFromHistory = false;

// Returns a shuffled copy, so the gallery's own order stays available for
// when randomisation is switched back off. (Fisher-Yates.)
function shuffle(array) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Stable per-item id: the thumbnail/poster basename. They all live in one
// directory so they're already unique, and unlike a positional index they
// don't shift when new photos are added — old links keep working.
function idFor(item) {
  const file = (item.type === "video" ? item.poster : item.thumb) || item.full;
  return file.split("/").pop().replace(/\.[^.]+$/, "");
}

function hashId() {
  return decodeURIComponent(location.hash.replace(/^#/, ""));
}

function urlFor(index) {
  return `${location.pathname}${location.search}#${encodeURIComponent(idFor(items[index]))}`;
}

/* -------------------------------------------------------------------------
   Lightbox
   ---------------------------------------------------------------------- */

function openLightbox(index) {
  current = index;
  showCurrent();
  if (!lightbox.open) {
    history.pushState({ lightbox: true }, "", urlFor(index));
    pushedEntry = true;
    lightbox.showModal();
  } else {
    history.replaceState({ lightbox: true }, "", urlFor(index));
  }
}

function showCurrent() {
  const p = items[current];
  const isVideo = p.type === "video";

  if (isVideo) {
    lightboxVideo.src = p.full;
    lightboxVideo.poster = p.poster;
    lightboxVideo.play().catch(() => {});
  } else {
    lightboxVideo.pause();
    lightboxVideo.removeAttribute("src");
    lightboxVideo.load();
    lightboxImg.src = p.full;
    lightboxImg.alt = `Photo ${current + 1} of ${items.length}`;
  }
  lightboxImg.classList.toggle("is-hidden-media", isVideo);
  lightboxVideo.classList.toggle("is-hidden-media", !isVideo);

  counter.textContent = `${current + 1} / ${items.length}`;
  // No wrap-around: the ends of the gallery are dead ends.
  prevBtn.classList.toggle("is-hidden", current === 0);
  nextBtn.classList.toggle("is-hidden", current === items.length - 1);
}

function step(delta) {
  // Manual navigation always wins over autoplay — treat it as "I'll take it
  // from here" rather than fighting the slideshow timer for control.
  stopSlideshow();
  const next = current + delta;
  if (next < 0 || next >= items.length) return;
  current = next;
  showCurrent();
  // Keep the grid underneath in step, so escaping out of the lightbox
  // leaves you on the page holding the photo you were just looking at.
  showPageFor(current);
  // Replace rather than push: arrowing through 300 photos shouldn't bury
  // the Back button under 300 history entries.
  history.replaceState({ lightbox: true }, "", urlFor(current));
}

// Switch the grid to the page containing a given gallery index.
function showPageFor(index) {
  const wanted = Math.floor(index / PAGE_SIZE);
  if (wanted === page) return;
  page = wanted;
  renderGrid();
}

function closeLightbox() {
  lightbox.close();
}

// On the way out of the lightbox, bring the thumbnail you were just
// looking at into view — after paging around, wherever the grid happens
// to be scrolled is rarely where that photo is.
function scrollCurrentIntoView() {
  const tile = grid.children[current - page * PAGE_SIZE];
  if (tile) tile.scrollIntoView({ block: "center" });
}

// All teardown lives here so the native Escape-closes-a-<dialog> path gets
// the same cleanup as our own close button.
lightbox.addEventListener("close", () => {
  stopSlideshow();
  lightboxVideo.pause();
  scrollCurrentIntoView();
  if (closingFromHistory) {
    closingFromHistory = false;
    return;
  }
  if (pushedEntry) {
    pushedEntry = false;
    history.back();
  } else if (location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
  }
});

// Back/forward, and pasting a different link into the address bar of an
// already-open tab (that fires hashchange, not a reload).
function syncFromUrl() {
  const index = idToIndex.get(hashId());
  if (index !== undefined) {
    current = index;
    showCurrent();
    showPageFor(current);
    if (!lightbox.open) lightbox.showModal();
    return;
  }
  pushedEntry = false;
  if (lightbox.open) {
    closingFromHistory = true;
    lightbox.close();
  }
}

window.addEventListener("popstate", syncFromUrl);
window.addEventListener("hashchange", syncFromUrl);

closeBtn.addEventListener("click", closeLightbox);
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));

lightbox.addEventListener("click", (e) => {
  // Click on the backdrop (the dialog element itself, not its content) closes it.
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", (e) => {
  if (!lightbox.open) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

/* -------------------------------------------------------------------------
   Slideshow
   ---------------------------------------------------------------------- */

const SLIDESHOW_INTERVAL_MS = 4500;
// Must match the CSS transition duration on .media-stage img/video.
const TRANSITION_MS = 450;
// One of these is picked at random for every advance — "left"/"right" slide
// past each other, "fade" eases through a slight scale instead.
const TRANSITION_VARIANTS = ["dir-left", "dir-right", "dir-fade"];

const SLIDESHOW_PLAY_ICON = `<path d="M6 4v16l14-8L6 4Z" />`;
const SLIDESHOW_STOP_ICON = `<rect x="6" y="6" width="12" height="12" rx="1.5" />`;

let slideshowActive = false;
let slideshowTimer = null;

function syncSlideshowButton() {
  slideshowToggleBtn.classList.toggle("on", slideshowActive);
  slideshowToggleIcon.innerHTML = slideshowActive ? SLIDESHOW_STOP_ICON : SLIDESHOW_PLAY_ICON;
  const label = slideshowActive ? "Stop slideshow" : "Start slideshow from here";
  slideshowToggleBtn.setAttribute("aria-label", label);
  slideshowToggleBtn.dataset.tip = label;
}

// Swaps to `next` with a random transition, then keeps the grid/URL in step
// exactly like manual step() does.
function transitionToIndex(next) {
  const variant = TRANSITION_VARIANTS[Math.floor(Math.random() * TRANSITION_VARIANTS.length)];
  mediaStage.classList.add("leaving", variant);

  window.setTimeout(() => {
    current = next;
    showCurrent();
    showPageFor(current);
    history.replaceState({ lightbox: true }, "", urlFor(current));

    // Jump the incoming media to its off-screen/faded starting point with no
    // transition, force a layout so the browser commits that before the next
    // line, then drop the class so it eases back to rest — the standard
    // trick for animating a state you just set with JS.
    mediaStage.classList.remove("leaving");
    mediaStage.classList.add("entering");
    void mediaStage.offsetWidth;
    mediaStage.classList.remove("entering", variant);
  }, TRANSITION_MS);
}

function slideshowAdvance() {
  // Autoplay loops back to the start — unlike manual prev/next, a slideshow
  // running out of photos and just stopping would be a strange surprise.
  transitionToIndex((current + 1) % items.length);
}

function startSlideshow() {
  if (slideshowActive || items.length < 2) return;
  slideshowActive = true;
  syncSlideshowButton();
  slideshowTimer = window.setInterval(slideshowAdvance, SLIDESHOW_INTERVAL_MS);
}

function stopSlideshow() {
  if (!slideshowActive) return;
  slideshowActive = false;
  window.clearInterval(slideshowTimer);
  slideshowTimer = null;
  mediaStage.classList.remove("leaving", "entering", ...TRANSITION_VARIANTS);
  syncSlideshowButton();
}

slideshowBtn.addEventListener("click", () => {
  if (items.length === 0) return;
  openLightbox(0);
  startSlideshow();
});

slideshowToggleBtn.addEventListener("click", () => {
  if (slideshowActive) stopSlideshow();
  else startSlideshow();
});

syncSlideshowButton();

/* -------------------------------------------------------------------------
   Thumbnail tiles
   ---------------------------------------------------------------------- */

function buildThumb(src) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  return img;
}

function buildPhotoTile(p, btn) {
  btn.appendChild(buildThumb(p.thumb));
}

function buildVideoTile(p, btn) {
  btn.appendChild(buildThumb(p.poster));

  const badge = document.createElement("span");
  badge.className = "play-badge";
  btn.appendChild(badge);

  // The hover-preview <video> is only created on first hover, so a page with
  // many videos doesn't kick off dozens of network requests on load.
  let video = null;
  let leaveTimer = null;

  btn.addEventListener("mouseenter", () => {
    clearTimeout(leaveTimer);
    if (!video) {
      video = document.createElement("video");
      video.className = "preview";
      video.src = p.preview;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      btn.appendChild(video);
    }
    btn.classList.add("video-hovering");
    video.currentTime = 0;
    video.play().catch(() => {});
  });

  btn.addEventListener("mouseleave", () => {
    btn.classList.remove("video-hovering");
    // Give the fade-out transition a moment before pausing.
    leaveTimer = setTimeout(() => video && video.pause(), 150);
  });
}

/* -------------------------------------------------------------------------
   Controls
   ---------------------------------------------------------------------- */

// Icon path data is inline rather than a sprite or icon font, so the toolbar
// needs no extra requests and can restyle with `currentColor`.
const FILTERS = [
  {
    label: "Showing photos and videos",
    tip: "Showing photos and videos — click for photos only",
    keep: () => true,
    icon: `<path d="M18 22H4a2 2 0 0 1-2-2V6" /><rect x="6" y="2" width="16" height="16" rx="2" />
           <circle cx="11" cy="8" r="1.6" /><path d="m22 12-3.3-3.3a2 2 0 0 0-2.8 0L10 15" />`,
  },
  {
    label: "Showing photos only",
    tip: "Showing photos only — click for videos only",
    keep: (p) => p.type !== "video",
    icon: `<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="1.8" />
           <path d="m21 15-4.6-4.6a2 2 0 0 0-2.8 0L3.5 20.5" />`,
  },
  {
    label: "Showing videos only",
    tip: "Showing videos only — click to show both",
    keep: (p) => p.type === "video",
    icon: `<path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" />`,
  },
];

// aria-label states what the control currently is; data-tip (the hover
// bubble) also says what clicking will do next.
function syncControls() {
  shuffleBtn.classList.toggle("on", randomize);
  shuffleBtn.setAttribute("aria-pressed", String(randomize));
  shuffleBtn.setAttribute("aria-label", randomize ? "Random order (on)" : "Random order (off)");
  shuffleBtn.dataset.tip = randomize
    ? "Random order — click for gallery order"
    : "Gallery order — click to shuffle";

  const filter = FILTERS[filterIndex];
  filterIcon.innerHTML = filter.icon;
  filterBtn.classList.toggle("on", filterIndex !== 0);
  filterBtn.setAttribute("aria-label", filter.label);
  filterBtn.dataset.tip = filter.tip;
}

/* -------------------------------------------------------------------------
   Grid and paging
   ---------------------------------------------------------------------- */

function pageCount() {
  return Math.max(1, Math.ceil(items.length / PAGE_SIZE));
}

// Draws one page of thumbnails plus the pager beneath it. Never touches
// the lightbox — `current` is a gallery-wide index and is independent of
// which page happens to be on screen.
function renderGrid() {
  const start = page * PAGE_SIZE;
  const shown = items.slice(start, start + PAGE_SIZE);

  grid.innerHTML = "";
  shown.forEach((p, i) => {
    const index = start + i;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Open ${p.type === "video" ? "video" : "photo"} ${index + 1}`);
    btn.addEventListener("click", () => openLightbox(index));

    if (p.type === "video") {
      buildVideoTile(p, btn);
    } else {
      buildPhotoTile(p, btn);
    }

    grid.appendChild(btn);
  });

  const pages = pageCount();
  pager.hidden = pages < 2;
  pagePrev.disabled = page === 0;
  pageNext.disabled = page >= pages - 1;
}

function goToPage(next) {
  const clamped = Math.min(Math.max(next, 0), pageCount() - 1);
  if (clamped === page) return;
  page = clamped;
  renderGrid();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  // Hold onto whatever the lightbox is showing so a reorder or a filter
  // change doesn't yank it out from under the viewer.
  const openId = lightbox.open && items.length ? idFor(items[current]) : null;

  const base = randomize ? shuffledItems : allItems;
  items = base.filter(FILTERS[filterIndex].keep);
  idToIndex.clear();
  items.forEach((p, i) => idToIndex.set(idFor(p), i));

  syncControls();

  if (items.length === 0) {
    subtitle.textContent = allItems.length ? "Nothing matches that filter." : "Nothing here yet.";
    grid.innerHTML = '<p class="empty">Check back soon.</p>';
    pager.hidden = true;
    if (lightbox.open) closeLightbox();
    return;
  }

  const photoCount = items.filter((p) => p.type !== "video").length;
  const videoCount = items.length - photoCount;
  const parts = [];
  if (photoCount) parts.push(`${photoCount} photo${photoCount === 1 ? "" : "s"}`);
  if (videoCount) parts.push(`${videoCount} video${videoCount === 1 ? "" : "s"}`);
  subtitle.textContent = parts.join(", ") + ", 2 best cats ever";

  // A reorder or filter change reshuffles what lives on which page, so
  // start from the top unless the lightbox anchors us somewhere.
  const stillShown = openId === null ? undefined : idToIndex.get(openId);
  current = stillShown === undefined ? 0 : stillShown;
  page = Math.floor(current / PAGE_SIZE);
  renderGrid();

  if (openId !== null) {
    if (stillShown === undefined) {
      // Filtered away — close rather than jump to some unrelated item.
      closeLightbox();
    } else {
      showCurrent();
      history.replaceState({ lightbox: true }, "", urlFor(current));
    }
  }
}

shuffleBtn.addEventListener("click", () => {
  randomize = !randomize;
  // Deal a fresh order each time it's turned on.
  if (randomize) shuffledItems = shuffle(allItems);
  render();
});

filterBtn.addEventListener("click", () => {
  filterIndex = (filterIndex + 1) % FILTERS.length;
  render();
});

pagePrev.addEventListener("click", () => goToPage(page - 1));
pageNext.addEventListener("click", () => goToPage(page + 1));

/* -------------------------------------------------------------------------
   Boot
   ---------------------------------------------------------------------- */

// Draw the icons before the gallery lands (and if it never does).
syncControls();

fetch("gallery.json")
  .then((r) => r.json())
  .then((data) => {
    allItems = data;
    shuffledItems = shuffle(allItems);
    render();

    // Arrived on a shared link: open that item immediately. No pushState —
    // there's no page-of-ours behind us to go back to, so closing strips
    // the hash instead.
    const deepLink = idToIndex.get(hashId());
    if (deepLink !== undefined) {
      current = deepLink;
      showCurrent();
      // So closing the shared link drops you on that photo's page.
      showPageFor(current);
      lightbox.showModal();
    }
  })
  .catch((err) => {
    console.error(err);
    subtitle.textContent = "Couldn't load the gallery.";
  });
