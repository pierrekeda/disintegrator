float expoIn( float t ) {
	return t == 0.0 ? t : pow( 2.0, 10.0 * ( t - 1.0 ) );
}