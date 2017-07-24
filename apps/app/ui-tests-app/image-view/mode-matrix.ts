import { Image, Stretch } from "tns-core-modules/ui/image";
import { GridLayout } from "tns-core-modules/ui/layouts/grid-layout";
import { Color } from "tns-core-modules/color";
import * as imageSource from "tns-core-modules/image-source";

const sources = [
    { src: "up", rotation: 0 },
    { src: "up-cw", rotation: -90 },
    { src: "up-flip", rotation: 180 },
    { src: "up-ccw", rotation: 90 }
].map(({ src, rotation }) => ({ src: `res://${src}`, rotation }));
const stretchModes: Stretch[] = ["none", "aspectFill", "aspectFit", "fill"];

export function navigatingTo(args) {
    const grid: GridLayout = args.object.getViewById("root");
    for (let x = 0; x < 12; x++) {
        for (let y = 0; y < 16; y++) {
            const image = new Image();

            const img = sources[x % 4];
            const src = imageSource.fromFileOrResource(img.src);
            src.rotationAngle = img.rotation;
            image.src = src;

            image.stretch = stretchModes[y % 4];
            image.row = y;
            image.col = x;

            grid.addChild(image);

            switch(Math.floor(x / 4)) {
                case 1:
                    image.borderWidth = "3";
                    break;
                case 2:
                    image.borderWidth = "3";
                    image.borderColor = "blue";
                    break;
            }

            switch(Math.floor(y / 4)) {
                case 1:
                    image.borderRadius = "12";
                    break;
                case 2:
                    image.borderRadius = "6 18 6 18";
                    break;
                case 3:
                    image.borderWidth = "0 2 4 6";
                    image.borderRadius = "6 18 6 18";
                    break;
            }

            image.backgroundColor = new Color(0x6600FFFF);
        }
    }
}