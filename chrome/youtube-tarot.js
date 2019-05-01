const DELAY_AFTER_IDLE = 0;
const STYLE_RATIO = 0.1;
const YOLO_CANVAS_SIZE = 416;

const UNIT_BBOX = { top: YOLO_CANVAS_SIZE / 2, left: YOLO_CANVAS_SIZE / 2, bottom: YOLO_CANVAS_SIZE / 2, right: YOLO_CANVAS_SIZE / 2 };

let model;
let styleTransfer = null;

const loadStyleTransfer = () => {
    return new Promise((res, rej) => {
        chrome.runtime.sendMessage(
            { 
                message: 'local_img_data', 
                url: chrome.runtime.getURL('tarot3_thesun.jpg') 
            }, 
            (response) => {
                const { data, width, height } = response;
                const imageData = new ImageData(Uint8ClampedArray.from(Object.values(data.data)), width, height);
                res(new StyleTransfer(imageData, STYLE_RATIO));
            }
        );
    });
};

const defer = (fn, delay) => () => downloadModel().then(async m => {
    model = m;
    console.log('downloaded Yolo model', m);

    styleTransfer = await loadStyleTransfer();
    await styleTransfer.loadModels();
    console.log('loaded ST models');

    fn();
});
const thumbnailUrlForID = id => `https://img.youtube.com/vi/${id}/0.jpg`;

const parseRecItem = (recItem) => {
    const link = recItem.querySelector('a#video-title');
    const id = (new URL(link.href)).searchParams.get('v');
    const thumbUrl = thumbnailUrlForID(id);

    return {
        title: link.innerText,
        url: link.href,
        image: thumbUrl
    };
}

const decodeImage = async buffer => {
    return new Promise((res, rej) => {
        inkjet.decode(buffer, (err, decoded) => {
            if (err) rej(err);
            else res([ Uint8ClampedArray.from(decoded.data), decoded.width, decoded.height ]);
        })
    });
}

const scalingCanvas = document.createElement('canvas');

const loadImage = async src => {
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const [array, width, height] = await decodeImage(buffer);
    const imageData = new ImageData(array, width, height);

    const scalingFactor = YOLO_CANVAS_SIZE / height;
    scalingCanvas.width = width * scalingFactor;
    scalingCanvas.height = height * scalingFactor;
    
    const context = scalingCanvas.getContext('2d');
    context.putImageData(imageData, 0, 0);
    context.scale(scalingFactor, scalingFactor);
    return { yolo: context.getImageData(0, 0, width, YOLO_CANVAS_SIZE), full: imageData };
}

const cropImage = (img) => {
    const size = Math.min(img.shape[0], img.shape[1]);
    const centerHeight = img.shape[0] / 2;
    const beginHeight = centerHeight - (size / 2);
    const centerWidth = img.shape[1] / 2;
    const beginWidth = centerWidth - (size / 2);
    return img.slice([beginHeight, beginWidth, 0], [size, size, 3]);
}

const numberToWord = [ 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen' ];

const joinBoundingBoxes = (jointBox, currentBox) => {
    jointBox.top = Math.min(jointBox.top, currentBox.top);
    jointBox.left = Math.min(jointBox.left, currentBox.left);
    jointBox.bottom = Math.max(jointBox.bottom, currentBox.bottom);
    jointBox.right = Math.max(jointBox.right, currentBox.right);
    return jointBox;
};

const yoloBBoxToImageBBox = (yoloBBox, width, height) => {
    const sideOffset = (width - height) / 2;
    return {
        top: yoloBBox.top / YOLO_CANVAS_SIZE * height,
        left: yoloBBox.left / YOLO_CANVAS_SIZE * height + sideOffset,
        bottom: Math.min(yoloBBox.bottom / YOLO_CANVAS_SIZE,  YOLO_CANVAS_SIZE / height) * height,
        right: yoloBBox.right / YOLO_CANVAS_SIZE * height + sideOffset
    };
};

const chooseObjects = (detectedObjects) => {
    const labels = detectedObjects.map(o => o.className);
    const labelHisto = labels.reduce((histo, label) => { histo[label] = (histo[label] || 0) + 1; return histo; }, {});
    const duplicate = Object.entries(labelHisto).find(([label, freq]) => freq > 1);

    if (duplicate) {
        const [singleLabel, freq] = duplicate;
        const label = `${numberToWord[freq - 1]} of ${singleLabel}s`;

        const chosenObjects = detectedObjects.filter(o => o.className === singleLabel);
        const bbox = chosenObjects.reduce(joinBoundingBoxes, UNIT_BBOX);

        return [label, bbox];

    } else {
        let chosenObjects = detectedObjects.filter(_ => Math.random() > 0.5).slice(0, 2);
        if (chosenObjects.length === 0) chosenObjects = [detectedObjects[0]];

        let label = chosenObjects.map(o => o.className).join(' & ');
        if (!label.includes('&')) label = `the ${label}`;

        const bbox = chosenObjects.reduce(joinBoundingBoxes, UNIT_BBOX);

        return [label, bbox];
    }
};

const renderTarotCard = async (container, recommendation) => {
    const image = await loadImage(recommendation.image);

    const tfImage = cropImage(tf.browser.fromPixels(image.yolo)).expandDims(0).toFloat().div(tf.scalar(255));
    const detectedObjects = await yolo(tfImage, model);

    if (detectedObjects.length === 0) {
        console.warn('No objects found in card');
        return;
    }

    const cardContainer = document.createElement('a');
    cardContainer.classList.add('tarot-card');
    cardContainer.href = recommendation.url;
    
    const background = new Image();
    background.src = chrome.runtime.getURL('tarot_frame.png');
    background.classList.add('tarot-bg');
    background.style.filter = 
        `saturate(${Math.random() * 60 + 80}%) hue-rotate(${Math.random() * 10 - 5}deg)`;
    cardContainer.appendChild(background);

    container.appendChild(cardContainer);

    const [label, bbox] = chooseObjects(detectedObjects);  
    const imageBBox = yoloBBoxToImageBBox(bbox, image.full.width, image.full.height);
    console.log(label, imageBBox);  
    
    const cardLabel = document.createElement('h3');
    cardLabel.classList.add('tarot-card__label');
    cardLabel.innerText = label;
    cardContainer.appendChild(cardLabel);

    const cardImageContainer = document.createElement('div');
    cardImageContainer.classList.add('tarot-image');
    cardContainer.appendChild(cardImageContainer);

    const cardImage = document.createElement('canvas');
    cardImage.width = image.full.width;
    cardImage.height = image.full.height;
    cardImageContainer.appendChild(cardImage);

    
    const cardImageData = new ImageData(cardImage.width, cardImage.height);
    await styleTransfer.style(image.full, cardImage);

    const cardImageContext = cardImage.getContext('2d');
    const croppedImageData = cardImageContext.getImageData(
        imageBBox.top, 
        imageBBox.left, 
        imageBBox.bottom - imageBBox.top + 10, 
        imageBBox.right - imageBBox.left + 10);
    
    const scalingFactor = (imageBBox.bottom - imageBBox.top) / image.full.height;
    cardImage.width = imageBBox.right - imageBBox.left;
    cardImage.height = imageBBox.bottom - imageBBox.top;

    cardImageContext.putImageData(croppedImageData, 0, 0);
};

const renderCards = async (container, recommendations) => {
    for (let rec of recommendations) {
        await renderTarotCard(container, rec);
    }
};

window.requestIdleCallback(defer(() => {
    const h2s = Array.from(document.getElementsByTagName('h2'));
    const h2Recommended = h2s.find(h2 => h2.innerText === 'Recommended');
    if (!h2Recommended) return;

    const container = h2Recommended.closest('.ytd-item-section-renderer');
    const showMoreBtn = container.querySelector('#show-more-button');
    showMoreBtn.click();

    const recItems = Array.from(container.querySelector('#items').children);
    const recommendations = recItems.map(parseRecItem);

    const itemContainer = recItems[0].parentElement;
    itemContainer.classList.add('tarot-container');
    recItems.forEach(item => itemContainer.removeChild(item));

    renderCards(itemContainer, recommendations);
}, DELAY_AFTER_IDLE));