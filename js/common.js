(function(){var $=function(s){return document.querySelector(s)},$$=function(s){return[].slice.call(document.querySelectorAll(s))};
var y=$("#yr");if(y)y.textContent=new Date().getFullYear();
var h=$("#hdr"),b=$("#progress");addEventListener("scroll",function(){h.classList.toggle("scrolled",scrollY>20);b.style.transform="scaleX("+scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight)+")"},{passive:true});
var m=$("#menu");$("#burger").addEventListener("click",function(){m.classList.toggle("open")});
$$(".menu>li>button").forEach(function(x){x.addEventListener("click",function(){if(innerWidth<=980)x.parentElement.classList.toggle("open")})});
$$(".menu a").forEach(function(a){a.addEventListener("click",function(){m.classList.remove("open")})});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})},{rootMargin:"0px 0px -80px 0px"});$$(".reveal").forEach(function(e){io.observe(e)});})();

;(function(){var rm=matchMedia("(prefers-reduced-motion: reduce)").matches;var vs=[].slice.call(document.querySelectorAll("video"));
if(rm){vs.forEach(function(v){v.removeAttribute("autoplay");v.pause()});return}
var sl=[].slice.call(document.querySelectorAll(".slide"));
function sync(){sl.forEach(function(s){var v=s.querySelector("video");if(!v)return;if(s.classList.contains("on")){var p=v.play();p&&p.catch&&p.catch(function(){})}else v.pause()})}
if(sl.length){sl.forEach(function(s){new MutationObserver(sync).observe(s,{attributes:true,attributeFilter:["class"]})});sync()}
var io=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;if(v.closest(".slide"))return;if(e.isIntersecting){var p=v.play();p&&p.catch&&p.catch(function(){})}else v.pause()})});
vs.forEach(function(v){io.observe(v)});
document.addEventListener("visibilitychange",function(){if(document.hidden)vs.forEach(function(v){v.pause()});else sync()});})();
