var scene,
    camera,
    renderer,
    element,
    container,
    effect,
    video,
    canvas,
    context;

navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;

init();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.001, 700);
  camera.position.set(0, 15, 0);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer();
  element = renderer.domElement;
  element.setAttribute('id', 'canvas');
  container = document.getElementById('webglviewer');
  container.appendChild(element);

  video = document.createElement('video');
  video.setAttribute('id', 'video');
  video.setAttribute('autoplay', true);
  document.body.appendChild(video);

  canvas = document.createElement('canvas');
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  context = canvas.getContext('2d');

  effect = new THREE.StereoEffect(renderer);

  var options = {
    video: {
      optional: [{facingMode: "environment"}]
    }
  };

  if (typeof MediaStreamTrack === 'undefined' && navigator.getUserMedia) {
    alert('This browser isn\'t supported');
  } else {
    MediaStreamTrack.getSources(function(sources) {
      for (var i = 0; i !== sources.length; ++i) {
        var source = sources[i];
        if (source.kind === 'video') {
          if (source.facing && source.facing == "environment") {
            options.video.optional.push({'sourceId': source.id});
          }
        }
      }

      navigator.getUserMedia(options, streamFound, streamError);
    });
  }

  function streamFound(stream) {
    video.src = URL.createObjectURL(stream);
    video.style.width = '100%';
    video.style.height = '100%';
    video.play();
    texture = new THREE.Texture(canvas);
    texture.context = context;

    var cameraPlane = new THREE.PlaneGeometry(1920, 1280);

    cameraMesh = new THREE.Mesh(cameraPlane, new THREE.MeshBasicMaterial({
      color: 0xffffff, opacity: 1, map: texture
    }));
    cameraMesh.position.z = -600;

    scene.add(cameraMesh);
  }

  function streamError(error) {
    console.log('Stream error: ', error);
  }

  animate();
}


function animate() {
  if (context) {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      texture.needsUpdate = true;
    }
  }

  requestAnimationFrame(animate);

  update();
  render();
}

function resize() {
  var width = container.offsetWidth;
  var height = container.offsetHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  effect.setSize(width, height);
}

function update(dt) {
  resize();

  camera.updateProjectionMatrix();
}

function render(dt) {
  effect.render(scene, camera);

  // Copy to canvas so it can be tracked
  var canvasToTrack = document.getElementById("canvasToTrack");
  var canvasToTrackContext = canvasToTrack.getContext("2d");
  canvasToTrackContext.drawImage(element, 0, 0, canvasToTrack.width, canvasToTrack.height);
}