float rand2D( in float x, in float y ) {

	vec2 co = vec2( x, y );
    return fract( sin( dot( co.xy, vec2( 12.9898,78.233 ) ) ) * 43758.5453 );

}