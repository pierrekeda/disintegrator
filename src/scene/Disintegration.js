import { BufferAttribute, Mesh, Vector3 } from 'three';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils';
import vesuna from 'vesuna';

import { FloatPack } from '../animation/FloatPack';
import { SimplexComputer } from '../animation/SimplexComputer';
import rand2D from '../glsl/noise/rand2D.glsl';

class Disintegration extends Mesh {

	constructor(
		geometry, material, {

			// Tesselation
			maxEdgeLength,
			maxIterations,

			// Densify
			density,

			// GPGPU
			spread,
			volatility,

			// Uniforms
			timeNoise,
			timeVariance,
			delay,
			wind,
			duration,

		} = {} ) {

		const tesselator = new TessellateModifier( maxEdgeLength, maxIterations );
		geometry = tesselator.modify( geometry );

		geometry = Disintegration.densify( geometry, density );

		super( geometry, material );

		this.options = {
			spread, volatility,
			delay, duration, timeNoise, timeVariance, wind
		};

		this.setAttributes();
		this.setChunks();
		material.onBeforeCompile = this.onBeforeCompile.bind( this );

	}

	setAttributes() {

		const { geometry } = this;

		const positions = geometry.attributes.position.array;
		const totalVertices = geometry.attributes.position.count;
		const totalFaces = Math.ceil( totalVertices / 3 );

		const aFace = new Float32Array( totalVertices );
		const aDataCoord = new Float32Array( totalVertices * 2 );
		const aCentroid = new Float32Array( totalVertices * 3 );

		const computeCentroid = Disintegration.computeCentroid;

		for ( let face = 0; face < totalFaces; face ++ ) {

			const i = face * 3;
			const i2 = i * 2;
			const i3 = i * 3;

			const dataCoordX = ( face % totalFaces ) / totalFaces;
			const dataCoordY = ~ ~ ( face / totalFaces ) / totalFaces;
			// ~ ~ is a less-legible, more performant bitwise Math.floor()
			// Used only because we're dealing with large arrays

			for ( let vertex = 0; vertex < 3; vertex ++ ) {

				const j = i + ( vertex );

				aFace[ j ] = face;

				const j2 = i2 + ( 2 * vertex );

				aDataCoord[   j2   ] = dataCoordX;
				aDataCoord[ j2 + 1 ] = dataCoordY;

				const j3 = i3 + ( 3 * vertex );

				aCentroid[   j3   ] = computeCentroid( i3, positions );
				aCentroid[ j3 + 1 ] = computeCentroid( i3 + 1, positions );
				aCentroid[ j3 + 2 ] = computeCentroid( i3 + 2, positions );

			}

		}

		geometry.setAttribute( 'aFace', new BufferAttribute( aFace, 1 ) );
		geometry.setAttribute( 'aDataCoord', new BufferAttribute( aDataCoord, 2 ) );
		geometry.setAttribute( 'aCentroid', new BufferAttribute( aCentroid, 3 ) );

		// GPGPU

		const x = new SimplexComputer( totalFaces );
		const y = new SimplexComputer( totalFaces );
		const z = new SimplexComputer( totalFaces );
		const duration = new SimplexComputer( totalFaces );
		this.gpgpu = { x, y, z, duration };
		this.compute();

	}

	compute() {

		const { gpgpu, shader, options } = this;

		const { spread, volatility } = options;
		const spreadUniforms = {
			uMin:   { value: - spread   },
			uMax:   { value: spread     },
			uScale: { value: volatility },
		};

		Object.entries( gpgpu ).forEach( ( [ key, computer ] ) => {

			computer.uniforms = JSON.parse( JSON.stringify( spreadUniforms ) );
			vesuna.seed = key;
			computer.uniforms.uSeed = { value: vesuna.random() };
			computer.compute();

		} );

		if ( ! shader ) return;
		const { uniforms } = shader;
		uniforms.tNoiseX.value = gpgpu.x.texture;
		uniforms.tNoiseY.value = gpgpu.y.texture;
		uniforms.tNoiseZ.value = gpgpu.z.texture;
		uniforms.tNoiseDuration.value = gpgpu.duration.texture;

	}

	onBeforeCompile( shader ) {

		const { gpgpu: gpgpu, options } = this;
		const { duration, timeNoise, timeVariance, delay, wind } = options;

		Object.assign( shader.uniforms, {
			uTime: { value: 0 },
			uTimeNoise: { value: timeNoise },
			uTimeVariance: { value: timeVariance },
			uDelay: { value: delay },
			uDuration: { value: duration },
			uWind: { value: wind },
			tNoiseX: { value: gpgpu.x.texture },
			tNoiseY: { value: gpgpu.y.texture },
			tNoiseZ: { value: gpgpu.z.texture },
			tNoiseDuration: { value: gpgpu.duration.texture },
		} );

		const main = 'void main()';
		const vertex = '#include <begin_vertex>';
		const { declarations, modifications } = this.chunks;

		let { vertexShader } = shader;
		vertexShader = vertexShader.replace( main, declarations + main );
		vertexShader = vertexShader.replace( vertex, vertex + modifications );
		shader.vertexShader = vertexShader;

		this.shader = shader;

	}

	setChunks() {

		const declarations = /*glsl*/`

			uniform float uTime;
			uniform float uTimeNoise;
			uniform float uTimeVariance;
			uniform float uDelay;
			uniform float uDuration;
			uniform vec3 uWind;
			uniform sampler2D tNoiseX;
			uniform sampler2D tNoiseY;
			uniform sampler2D tNoiseZ;
			uniform sampler2D tNoiseDuration;

			attribute float aFace;
			attribute vec2 aDataCoord;
			attribute vec3 aCentroid;

			${FloatPack.glsl}
			${rand2D}

		`;

		const modifications = /*glsl*/`

			float noiseX = unpack( texture2D( tNoiseX, aDataCoord ) );
			float noiseY = unpack( texture2D( tNoiseY, aDataCoord ) );
			float noiseZ = unpack( texture2D( tNoiseZ, aDataCoord ) );
			float noiseDuration = unpack( texture2D( tNoiseDuration, aDataCoord ) );
			noiseDuration = clamp(
				noiseDuration * uTimeVariance * uDuration,
				0.0, 
				uDuration - 0.01
			);
			float duration = uDuration - noiseDuration;

			float noiseDelay = rand2D( aFace, 0.618 ) * uTimeNoise;
			float delay = uDelay + noiseDelay;

			float time = clamp( uTime - delay, 0.0, duration );
			float progress =  clamp( time / duration, 0.0, 1.0 );

			vec3 wind = uWind;

			// Invert
			//progress = 1.0 - progress; 
			//wind *= -1.0;
		
			float scale = clamp( 1.0 - progress, 0.0, 1.0 );
			transformed -= aCentroid;
			transformed *= scale;
			transformed += aCentroid;
		
			transformed.x += ( noiseX + wind.x ) * progress;
			transformed.y += ( noiseY + wind.y ) * progress;
			transformed.z += ( noiseZ + wind.z ) * progress;

		`;

		this.chunks = { declarations, modifications };

	}

	update( time ) {

		this.shader.uniforms.uTime.value = time;

	}

	get totalVertices() {

		return this.geometry.attributes.position.count;

	}

}

Disintegration.densify = ( geometry, density ) => {

	if (
		density < 1 ||
		! Number.isInteger( density ) ||
		! Number.isFinite( density )
	) return geometry;

	geometry.computeBoundingBox();

	const box = geometry.boundingBox;
	const minSize = Math.min(
		box.max.x - box.min.x,
		box.max.y - box.min.y,
		box.max.z - box.min.z,
	);
	const step = minSize * 0.01;

	let layeredGeometries = Array.from( { length: density }, ( _, i ) => {

		const clone = geometry.clone();
		const scale = 1 - step * ( i + 1 );
		clone.scale( scale, scale, scale );
		return clone;

	} );
	layeredGeometries.push( geometry );

	return mergeBufferGeometries( layeredGeometries );

};

Disintegration.computeCentroid = ( i, pos ) =>
	( pos[ i ] + pos[ i + 3 ] + pos[ i + 6 ] ) / 3;

export { Disintegration };
